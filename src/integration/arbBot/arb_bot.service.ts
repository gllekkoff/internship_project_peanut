import { erc20Abi } from 'viem';
import type { Hex } from 'viem';
import { config as envConfig, chain as viemChain } from '@/configs/configs.service';
import { Address } from '@/core/core.types';
import type { Token } from '@/core/core.types';
import { WalletManager } from '@/core/wallet.service';
import { PRICE_SCALE, PRICE_SCALE_NUM } from '@/core/core.constants';
import { ChainClient } from '@/chain/chain.client';
import { ExchangeClient } from '@/exchange/cexClient/exchange.client';
import type { OrderBook, TradeEvent } from '@/exchange/cexClient/exchange.interfaces';
import { UniswapV2Pair } from '@/pricing/uniswap-v2/uniswap-v2.service';
import { PricingEngine } from '@/pricing/engine/engine.service';
import { getBinanceProfile } from '@/venues/binance/binance.profile';
import { VenueHydrator } from '@/venues/venue.hydrator';
import type { VenueProfile } from '@/venues/venue.interfaces';
import { InventoryTracker } from '@/inventory/tracker/tracker.service';
import { RebalancePlanner } from '@/inventory/rebalancer/rebalancer.service';
import { PnLEngine } from '@/inventory/pnl/pnl.service';
import { Venue } from '@/inventory/tracker/tracker.interfaces';
import { FeeCalculator } from '@/strategy/fee.calculator';
import { SignalGenerator } from '@/strategy/signal.generator';
import { SignalScorer } from '@/strategy/scorer/scorer.service';
import { Executor } from '@/executor/engine/engine.service';
import { ExecutorState } from '@/executor/engine/engine.interfaces';
import { Signal } from '@/strategy/signal.interfaces';
import { signalToArbRecord, executionToArbRecord } from '@/integration/arbBot/arb_bot.utils';
import type { BotConfig } from '@/integration/arbBot/arb_bot.interfaces';
import {
  BALANCE_SYNC_INTERVAL_MS,
  DAILY_RESET_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
  BASE_MISMATCH_THRESHOLD,
  QUOTE_MISMATCH_THRESHOLD,
  SWAP_GAS_UNITS,
  GAS_PRICE_TTL_MS,
  GAS_COST_FALLBACK,
  GAS_COST_MIN,
} from '@/integration/arbBot/arb_bot.constants';
import { RiskManager } from '@/safety/risk.service';
import { DEFAULT_RISK_LIMITS } from '@/safety/risk.constants';
import { absoluteSafetyCheck } from '@/safety/safety.constants';
import { isKillSwitchActive, AutoKillSwitch, writeHeartbeat } from '@/safety/kill.switch';
import { PreTradeValidator } from '@/safety/pre.trade.validator';
import { makeLogger, logError } from '@/core/core.logger';
import { fmtUsd, fmtPrice, fmtAmt } from '@/core/core.formatters';
import { TelegramNotifier } from '@/notifications/telegram.notifier';

function fmtDirection(direction: string): string {
  return direction === 'buy_dex_sell_cex' ? 'Buy DEX → Sell CEX' : 'Buy CEX → Sell DEX';
}

function toCexSymbol(symbol: string): string {
  const MAP: Record<string, string> = {
    WETH: 'ETH',
    'USD₮0': 'USDT',
    'USDC.e': 'USDC',
  };
  return MAP[symbol] ?? symbol;
}

enum BotState {
  IDLE = 'IDLE',
  GENERATING = 'GENERATING',
  EXECUTING = 'EXECUTING',
}

const log = makeLogger('ArbBot');

export class ArbBot {
  private readonly exchange: ExchangeClient;
  private readonly chainClient: ChainClient;
  private readonly flashbotsChainClient: ChainClient | null;
  private readonly pricingEngine: PricingEngine;
  private readonly venueProfile: VenueProfile;
  private readonly inventory: InventoryTracker;
  private readonly planner: RebalancePlanner;
  private readonly pnl: PnLEngine;
  private fees: FeeCalculator;
  private readonly scorer: SignalScorer;
  private readonly wallet: WalletManager;
  private readonly riskManager: RiskManager;
  private readonly preTrade: PreTradeValidator;
  private readonly autoKill: AutoKillSwitch;
  private readonly telegram: TelegramNotifier;
  private dailyLossAlerted = false;
  private circuitBreakerNotified = false;
  private dailyTradeCount = 0;
  private dailyNetPnl = 0n;
  private dailyWins = 0;

  private generator!: SignalGenerator;
  private executor!: Executor;
  private loadedPool: UniswapV2Pair | null = null;
  private baseToken: Token | null = null;
  private quoteToken: Token | null = null;
  private startingCapital = 0n;
  private basePair = 'ETH';
  private quotePair = 'USDC';

  private activePair = 'ETH/USDC';
  private tickState: BotState = BotState.IDLE;
  private stopping = false;
  private readonly tickTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private lastResetDay = new Date().getUTCDate();
  private stopResolve: (() => void) | null = null;
  private gasCache: { cost: bigint; ts: number } | null = null;
  private readonly latestBooks: Map<string, OrderBook> = new Map();

  constructor(private readonly botConfig: BotConfig) {
    this.venueProfile = getBinanceProfile(envConfig.production);
    this.exchange = new ExchangeClient(envConfig.binance, this.venueProfile);
    this.chainClient = new ChainClient([envConfig.chain.rpcUrl], 30, 3, viemChain);
    this.flashbotsChainClient = null;
    this.pricingEngine = new PricingEngine(
      this.chainClient,
      envConfig.fork.rpcUrl,
      envConfig.chain.wsUrl,
      viemChain,
      new Address(envConfig.dex.router),
    );
    this.wallet = WalletManager.from_env('PRIVATE_KEY');

    this.inventory = new InventoryTracker([Venue.BINANCE, Venue.WALLET]);
    this.planner = new RebalancePlanner(this.inventory, this.venueProfile);
    this.pnl = new PnLEngine();

    this.fees = new FeeCalculator({
      cexTakerBps: envConfig.binance.cexFeeBps,
      dexSwapBps: 30,
      gasCost: 5n * PRICE_SCALE,
    });

    this.scorer = new SignalScorer({
      excellentSpreadBps: 100,
      minSpreadBps: botConfig.minSpreadBps,
    });
    this.riskManager = new RiskManager(botConfig.riskLimits ?? DEFAULT_RISK_LIMITS, 0n);
    this.preTrade = new PreTradeValidator();
    this.autoKill = new AutoKillSwitch();
    this.telegram = new TelegramNotifier(envConfig.telegram.botToken, envConfig.telegram.chatId);
  }

  private async initialize(): Promise<void> {
    log.info('Hydrating venue profile...');
    const hydrator = new VenueHydrator();
    await hydrator
      .hydrate(this.venueProfile, this.exchange)
      .catch((e) => log.warn(`VenueHydrator failed — using static defaults: ${String(e)}`));

    log.info('Loading pool data from chain...');
    const poolAddress = new Address(envConfig.dex.pool);
    const [pool] = await Promise.all([
      UniswapV2Pair.fromChain(poolAddress, this.chainClient),
      this.pricingEngine.loadPools([poolAddress]),
    ]);
    const baseLower = this.botConfig.baseTokenAddress.toLowerCase();
    const baseIsToken0 = pool.token0.address.lower === baseLower;
    if (!baseIsToken0 && pool.token1.address.lower !== baseLower) {
      throw new Error(
        `baseTokenAddress ${this.botConfig.baseTokenAddress} not found in pool ` +
          `(token0=${pool.token0.address.value} token1=${pool.token1.address.value})`,
      );
    }
    const baseToken: Token = baseIsToken0 ? pool.token0 : pool.token1;
    const quoteToken: Token = baseIsToken0 ? pool.token1 : pool.token0;

    const quoteLower = this.botConfig.quoteTokenAddress.toLowerCase();
    if (quoteToken.address.lower !== quoteLower) {
      throw new Error(
        `quoteTokenAddress ${this.botConfig.quoteTokenAddress} does not match pool's other token ` +
          `(expected ${quoteToken.address.value})`,
      );
    }

    this.activePair = `${toCexSymbol(baseToken.symbol)}/${toCexSymbol(quoteToken.symbol)}`;
    this.basePair = toCexSymbol(baseToken.symbol);
    this.quotePair = toCexSymbol(quoteToken.symbol);

    const pairTokens: Map<string, readonly [Token, Token]> = new Map([
      [this.activePair, [baseToken, quoteToken] as const],
    ]);
    log.info(
      `Pool loaded: ${baseToken.symbol}/${quoteToken.symbol} feeBps=${pool.feeBps} → CEX pair ${this.activePair}`,
    );

    this.fees = new FeeCalculator({
      cexTakerBps: envConfig.binance.cexFeeBps,
      dexSwapBps: Number(pool.feeBps),
      gasCost: 5n * PRICE_SCALE,
    });

    this.loadedPool = pool;
    this.baseToken = baseToken;
    this.quoteToken = quoteToken;

    await this.pricingEngine.startPoolMonitor([poolAddress]);

    log.info('Fetching trading rules from Binance...');
    const rules = await this.exchange.fetchTradingRules(this.activePair);
    const tradingRules = new Map([[this.activePair, rules]]);

    const senderAddress = new Address(this.wallet.getAddress());

    this.generator = new SignalGenerator(
      this.exchange,
      this.pricingEngine,
      this.inventory,
      this.fees,
      {
        minSpreadBps: this.botConfig.minSpreadBps,
        tradeSizeUsd: this.botConfig.tradeSizeUsd,
        ...(this.botConfig.tradeSizeMin !== undefined
          ? { tradeSizeMin: this.botConfig.tradeSizeMin }
          : {}),
        ...(this.botConfig.tradeSizeMax !== undefined
          ? { tradeSizeMax: this.botConfig.tradeSizeMax }
          : {}),
        minProfit: this.botConfig.minProfit ?? 0n,
        maxPosition: 20_000n * PRICE_SCALE,
        cooldownMs: this.botConfig.cooldownMs,
        senderAddress,
        pairTokens,
        poolAddress: envConfig.dex.pool,
      },
      this.chainClient,
    );

    this.executor = new Executor(
      this.exchange,
      this.pricingEngine,
      this.inventory,
      this.venueProfile,
      {
        simulationMode: this.botConfig.simulationMode,
        useFlashbots: false,
        router: new Address(envConfig.dex.router),
        pairTokens,
        tradingRules,
      },
      this.chainClient,
      this.wallet,
      this.flashbotsChainClient,
    );
  }

  async run(): Promise<void> {
    log.info('Bot starting...');

    await this.exchange.connect();
    await this.syncBalances();

    await this.initialize();
    await this.syncBalances();

    this.startingCapital = this.computeCapitalFromInventory(this.basePair, this.quotePair);
    this.riskManager.setInitialCapital(this.startingCapital);
    log.info(
      `Initial capital: ${fmtUsd(this.startingCapital)} (${this.basePair} wallet + ${this.quotePair} CEX)`,
    );
    this.logRebalancePlans();

    this.exchange.subscribeDepth(this.activePair, (book) => {
      this.latestBooks.set(this.activePair, book);
      const existing = this.tickTimers.get(this.activePair);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        this.tickTimers.delete(this.activePair);
        void this.tick(this.activePair, book);
      }, 50);
      this.tickTimers.set(this.activePair, timer);
    });
    this.exchange.subscribeTrades(this.activePair, (trade) => {
      this.onTradeUpdate(this.activePair, trade);
    });

    this.exchange.connectWs();
    log.info(`WebSocket connected — watching ${this.activePair}`);

    this.telegram.onCommand('stop', () => {
      if (this.stopping) return;
      log.warn('Telegram /stop received — shutting down');
      void this.stop();
    });
    this.telegram.startListening();

    const mode = this.botConfig.simulationMode
      ? 'DRY RUN'
      : envConfig.production
        ? 'PRODUCTION'
        : 'testnet';
    const walletBase = this.inventory.getAvailable(Venue.WALLET, this.basePair);
    const cexQuote = this.inventory.getAvailable(Venue.BINANCE, this.quotePair);

    const minProfitUsd = Number(this.botConfig.minProfit ?? 0n) / PRICE_SCALE_NUM;
    const tradeSizeMinUsd =
      Number(this.botConfig.tradeSizeMin ?? this.botConfig.tradeSizeUsd) / PRICE_SCALE_NUM;
    const tradeSizeMaxUsd =
      Number(this.botConfig.tradeSizeMax ?? this.botConfig.tradeSizeUsd) / PRICE_SCALE_NUM;
    const sizeLabel =
      tradeSizeMinUsd === tradeSizeMaxUsd
        ? `$${tradeSizeMinUsd.toFixed(2)}`
        : `$${tradeSizeMinUsd.toFixed(2)} – $${tradeSizeMaxUsd.toFixed(2)} (sweep)`;

    const settingsLine =
      `Settings:\n` +
      `  Trade size: ${sizeLabel}\n` +
      `  Min spread: ${this.botConfig.minSpreadBps} bps\n` +
      `  Min score: ${this.botConfig.minScore}\n` +
      `  Min profit: ${minProfitUsd >= 0 ? '+' : ''}$${minProfitUsd.toFixed(2)}\n` +
      `  Cooldown: ${this.botConfig.cooldownMs} ms`;

    log.info(
      `Settings — trade size: ${sizeLabel} | spread: ${this.botConfig.minSpreadBps}bps` +
        ` | score: ${this.botConfig.minScore} | min profit: ${minProfitUsd >= 0 ? '+' : ''}$${minProfitUsd.toFixed(2)}` +
        ` | cooldown: ${this.botConfig.cooldownMs}ms`,
    );

    await this.telegram.sendControlPanel(
      `Bot started ✅\n` +
        `Pair: ${this.activePair}\n` +
        `Mode: ${mode}\n\n` +
        `Wallet: ${fmtAmt(walletBase)} ${this.basePair}\n` +
        `CEX: ${fmtUsd(cexQuote)} ${this.quotePair}\n` +
        `Total capital: ${fmtUsd(this.startingCapital)}\n\n` +
        `${settingsLine}\n\n` +
        `Use /stop or the button below to shut down.`,
    );

    const balanceTimer = setInterval(() => {
      void this.syncBalances();
    }, BALANCE_SYNC_INTERVAL_MS);

    const resetTimer = setInterval(() => {
      void this.maybeDailyReset();
    }, DAILY_RESET_INTERVAL_MS);

    writeHeartbeat();
    const heartbeatTimer = setInterval(() => {
      writeHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);

    await new Promise<void>((resolve) => {
      this.stopResolve = resolve;
    });

    clearInterval(balanceTimer);
    clearInterval(resetTimer);
    clearInterval(heartbeatTimer);
    this.exchange.disconnectWs();
    this.pricingEngine.stopPoolMonitor();
    this.telegram.stopListening();
  }

  private async tick(pair: string, book: OrderBook): Promise<void> {
    if (!this.checkSafetyGates()) return;
    if (this.tickState !== BotState.IDLE) return;
    this.tickState = BotState.GENERATING;
    try {
      const signal = await this.generateAndFilterSignal(pair, book);
      if (!signal || !this.runRiskChecks(signal)) return;
      this.tickState = BotState.EXECUTING;
      if (this.botConfig.simulationMode) {
        this.runDryRun(signal);
        return;
      }
      await this.executeReal(signal, pair, book);
    } catch (e) {
      logError(log, 'Depth handler error', {
        pair,
        error: e instanceof Error ? e.message : String(e),
      });
      // Only count execution failures toward auto-kill — transient network/data errors
      // during signal generation should not permanently stop the bot.
      if (this.tickState === BotState.EXECUTING) {
        this.autoKill.recordError();
      }
    } finally {
      this.tickState = BotState.IDLE;
    }
  }

  /** Returns false and triggers shutdown when kill switch or auto-kill fires. */
  private checkSafetyGates(): boolean {
    if (isKillSwitchActive()) {
      log.error('KILL SWITCH ACTIVE — stopping bot');
      void this.telegram.send('Kill switch activated — bot stopped', true);
      void this.stop();
      return false;
    }
    const riskSnap = this.riskManager.status();
    const currentCapital = BigInt(Math.round(riskSnap.currentCapitalUsd * PRICE_SCALE_NUM));
    if (this.autoKill.check(currentCapital, this.startingCapital)) {
      log.error(`AUTO KILL SWITCH triggered — ${this.autoKill.reason}`);
      void this.telegram.send(`Auto kill switch triggered\nReason: ${this.autoKill.reason}`, true);
      void this.stop();
      return false;
    }
    return true;
  }

  private async generateAndFilterSignal(pair: string, book: OrderBook): Promise<Signal | null> {
    this.fees.gasCost = await this.estimateGasCostUsd();

    const signal = await this.generator.generate(pair, book);
    if (!signal) return null;

    const preCheck = this.preTrade.validateSignal(signal);
    if (!preCheck.allowed) {
      log.debug(`[${pair}] pre-trade validation failed: ${preCheck.reason}`);
      return null;
    }

    const [base = '', quote = ''] = pair.split('/');
    const checks = this.planner.checkAll();
    for (const check of checks) {
      if (check.needsRebalance && (check.asset === base || check.asset === quote)) {
        log.warn(`Rebalance needed: ${check.asset} skew=${check.maxDeviationPct.toFixed(1)}%`);
      }
    }

    const rawScore = this.scorer.score(signal, checks);
    const score = this.scorer.applyDecay(signal, rawScore);
    const size = Number(signal.size) / PRICE_SCALE_NUM;

    if (score < this.botConfig.minScore) {
      log.debug(
        `[${pair}] SKIP score=${score.toFixed(0)}<${this.botConfig.minScore}` +
          ` spread=${signal.spreadBps.toFixed(1)}bps net=${fmtUsd(signal.expectedNetPnl)}`,
      );
      return null;
    }

    const minProfit = this.minProfitBuffer(signal);
    if (signal.expectedNetPnl < minProfit) {
      log.debug(
        `[${pair}] SKIP net=${fmtUsd(signal.expectedNetPnl)} below buffer=${fmtUsd(minProfit)}` +
          ` spread=${signal.spreadBps.toFixed(1)}bps score=${score.toFixed(0)}`,
      );
      return null;
    }

    log.info('─'.repeat(60));
    log.info(`SIGNAL — ${pair} ${signal.direction}`);
    log.info(`  Signal ID  : ${signal.signalId}`);
    log.info(`  Size       : ${size.toFixed(4)} ${base}`);
    log.info(`  CEX price  : ${fmtPrice(signal.cexPrice)}`);
    log.info(`  DEX price  : ${fmtPrice(signal.dexPrice)}`);
    log.info(`  Spread     : ${signal.spreadBps.toFixed(1)} bps`);
    log.info(`  Gross PnL  : ${fmtUsd(signal.expectedGrossPnl)}`);
    log.info(`  Fees       : ${fmtUsd(signal.expectedFees)}`);
    log.info(`  Net PnL    : ${fmtUsd(signal.expectedNetPnl)}`);
    log.info(`  Score      : ${score.toFixed(0)} / 100 (threshold ${this.botConfig.minScore})`);
    log.info(`  Expires    : ${signal.expiry.toISOString()}`);
    log.info('─'.repeat(60));

    return signal;
  }

  /** Runs risk manager and absolute safety ceiling checks. Returns false to skip the tick. */
  private runRiskChecks(signal: Signal): boolean {
    const riskCheck = this.riskManager.checkPreTrade(signal);
    if (!riskCheck.allowed) {
      log.warn(`  → Blocked by risk manager: ${riskCheck.reason}`);
      if (riskCheck.reason.includes('Daily loss limit') && !this.dailyLossAlerted) {
        this.dailyLossAlerted = true;
        const risk = this.riskManager.status();
        void this.telegram.send(
          `Daily loss limit reached - stopping\nDaily PnL: ${risk.dailyPnlUsd.toFixed(2)} USD`,
          true,
        );
      }
      return false;
    }

    const riskStatus = this.riskManager.status();
    const tradeUsd = (signal.size * signal.cexPrice) / PRICE_SCALE;
    const safetyCheck = absoluteSafetyCheck(
      tradeUsd,
      BigInt(Math.round(riskStatus.dailyPnlUsd * PRICE_SCALE_NUM)),
      BigInt(Math.round(riskStatus.currentCapitalUsd * PRICE_SCALE_NUM)),
      riskStatus.tradesThisHour,
    );
    if (!safetyCheck.allowed) {
      log.error(`  → ABSOLUTE SAFETY LIMIT: ${safetyCheck.reason}`);
      return false;
    }

    return true;
  }

  private runDryRun(signal: Signal): void {
    const [base = ''] = signal.pair.split('/');
    const size = Number(signal.size) / PRICE_SCALE_NUM;
    log.info(
      `DRY RUN | Would trade: ${signal.pair} ${signal.direction}` +
        ` size = ${size.toFixed(4)} ${base} spread = ${signal.spreadBps.toFixed(1)}bps` +
        ` expected_pnl = ${fmtUsd(signal.expectedNetPnl)}`,
    );
    this.riskManager.recordTrade(signal.expectedNetPnl);
    this.pnl.record(signalToArbRecord(signal));
    this.dailyTradeCount++;
    this.dailyNetPnl += signal.expectedNetPnl;
    if (signal.expectedNetPnl > 0n) this.dailyWins++;
    const sessionNetUsd = Number(this.dailyNetPnl) / PRICE_SCALE_NUM;
    void this.telegram.send(
      `[DRY RUN] Would trade: ${signal.pair}\n` +
        `Direction: ${fmtDirection(signal.direction)}\n` +
        `Size: ${size.toFixed(4)} ${base} | Spread: ${signal.spreadBps.toFixed(1)}bps\n` +
        `Expected PnL: ${fmtUsd(signal.expectedNetPnl)}\n` +
        `Session: ${this.dailyTradeCount} signals | ${sessionNetUsd >= 0 ? '+' : ''}$${sessionNetUsd.toFixed(4)} net`,
    );
  }

  private async executeReal(signal: Signal, pair: string, book: OrderBook): Promise<void> {
    const [base = '', quote = ''] = pair.split('/');
    const minProfit = this.minProfitBuffer(signal);
    const size = Number(signal.size) / PRICE_SCALE_NUM;

    const freshSignal = await this.generator.peek(pair, this.latestBooks.get(pair) ?? book);
    if (!freshSignal || freshSignal.expectedNetPnl < minProfit) {
      log.debug(`[${pair}] opportunity gone by execution time`);
      return;
    }

    if (this.executor.isCircuitBreakerOpen()) {
      const resetSec = Math.ceil(this.executor.circuitBreakerResetMs() / 1000);
      if (!this.circuitBreakerNotified) {
        this.circuitBreakerNotified = true;
        log.warn(`Circuit breaker open — skipping trades for ~${resetSec}s`);
        void this.telegram.send(
          `⚠️ Circuit breaker tripped\nToo many failed trades.\nWaiting ~${Math.ceil(resetSec / 60)} min before retrying.`,
          true,
        );
      } else {
        log.debug(`Circuit breaker open — ${resetSec}s remaining`);
      }
      return;
    }
    this.circuitBreakerNotified = false;

    log.info(`[${pair}] EXECUTING ${size.toFixed(4)} ${base}`);
    const ctx = await this.executor.execute(freshSignal);
    this.scorer.recordResult(pair, ctx.state === ExecutorState.DONE);

    if (ctx.state === ExecutorState.DONE) {
      const netPnl = ctx.actualNetPnlUsd ?? 0n;
      this.riskManager.recordTrade(netPnl);
      this.pnl.record(executionToArbRecord(ctx));
      this.dailyTradeCount++;
      this.dailyNetPnl += netPnl;
      if (netPnl > 0n) this.dailyWins++;
      const summary = this.pnl.summary();
      const risk = this.riskManager.status();
      const pnlUsd = Number(netPnl) / PRICE_SCALE_NUM;
      const winRate = (summary.winRate * 100).toFixed(0);

      log.info('─'.repeat(60));
      log.info(`TRADE COMPLETE — ${signal.pair} ${signal.direction}`);
      log.info(`  Signal ID  : ${signal.signalId}`);
      log.info(`  Size       : ${size.toFixed(4)} ${base}`);
      log.info(`  CEX price  : ${fmtPrice(signal.cexPrice)}`);
      log.info(`  DEX price  : ${fmtPrice(signal.dexPrice)}`);
      log.info(`  Spread     : ${signal.spreadBps.toFixed(1)} bps`);
      log.info(`  Gross PnL  : ${fmtUsd(signal.expectedGrossPnl)}`);
      log.info(`  Fees       : ${fmtUsd(signal.expectedFees)}`);
      log.info(`  Net PnL    : ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(4)}`);
      log.info(
        `  Session    : ${summary.totalTrades} trades | total ${fmtUsd(summary.totalPnlUsd)} | win ${winRate}%`,
      );
      log.info(
        `  Risk       : daily=${risk.dailyPnlUsd.toFixed(4)} drawdown=${risk.drawdownPct.toFixed(1)}%`,
      );
      log.info('─'.repeat(60));

      const sessionNetUsd = Number(this.dailyNetPnl) / PRICE_SCALE_NUM;
      const sessionWinRate =
        this.dailyTradeCount > 0 ? ((this.dailyWins / this.dailyTradeCount) * 100).toFixed(0) : '0';
      void this.telegram.send(
        `✅ Trade completed\n\n` +
          `Pair: ${signal.pair}\n` +
          `Direction: ${fmtDirection(signal.direction)}\n` +
          `Size: ${size.toFixed(4)} ${base}\n\n` +
          `CEX price: ${fmtPrice(signal.cexPrice)}\n` +
          `DEX price: ${fmtPrice(signal.dexPrice)}\n` +
          `Spread: ${signal.spreadBps.toFixed(1)} bps\n\n` +
          `Gross PnL: ${fmtUsd(signal.expectedGrossPnl)}\n` +
          `Fees: ${fmtUsd(signal.expectedFees)}\n` +
          `Net PnL: ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(4)}\n\n` +
          `Session: ${this.dailyTradeCount} trades | ${sessionNetUsd >= 0 ? '+' : ''}$${sessionNetUsd.toFixed(4)} net | ${sessionWinRate}% win rate`,
      );
    } else {
      const failMsg = `TRADE FAILED — state=${ctx.state}${ctx.error ? ` error=${ctx.error}` : ''}`;
      log.warn(`[${pair}] ${failMsg}`);
      void this.telegram.send(
        `❌ Trade failed\n\n` +
          `Pair: ${signal.pair}\n` +
          `Direction: ${fmtDirection(signal.direction)}\n` +
          `Size: ${size.toFixed(4)} ${base}\n\n` +
          `State: ${ctx.state}\n` +
          (ctx.error ? `Error: ${ctx.error}` : ''),
        true,
      );
    }

    if (ctx.state === ExecutorState.DONE) {
      await this.verifyBalances(base, quote);
    } else {
      // Failed trades are unwound back to the original position — just resync inventory.
      await this.syncBalances();
    }
    const baseAfter = this.inventory.getAvailable(Venue.WALLET, base);
    const quoteAfter = this.inventory.getAvailable(Venue.BINANCE, quote);
    log.debug(
      `[${pair}] post-trade: ${base}@wallet=${fmtAmt(baseAfter)}  ${quote}@cex=${fmtUsd(quoteAfter)}`,
    );
    this.logRebalancePlans();
  }

  private onTradeUpdate(pair: string, trade: TradeEvent): void {
    const sizeEth = Number(trade.quantity) / PRICE_SCALE_NUM;
    if (sizeEth >= 5) {
      const side = trade.isBuyerMaker ? 'SELL' : 'BUY';
      log.info(`Trade [${pair}] ${side} ${sizeEth.toFixed(3)} @ ${fmtPrice(trade.price)}`);
    }
  }

  private async maybeDailyReset(): Promise<void> {
    const today = new Date().getUTCDate();
    if (today === this.lastResetDay) return;

    const trades = this.dailyTradeCount;
    const pnl = this.dailyNetPnl;
    const wins = this.dailyWins;
    const pnlUsd = Number(pnl) / PRICE_SCALE_NUM;
    const winRate = trades > 0 ? ((wins / trades) * 100).toFixed(0) : '—';
    const risk = this.riskManager.status();

    log.info(
      `Daily reset — trades: ${trades}  pnl: ${fmtUsd(pnl)}  win: ${winRate}%  drawdown: ${risk.drawdownPct.toFixed(1)}%`,
    );
    await this.telegram.send(
      `Daily summary 📊\n` +
        `Trades: ${trades}\n` +
        `PnL: ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)}\n` +
        `Win rate: ${winRate}%\n` +
        `Drawdown: ${risk.drawdownPct.toFixed(1)}%`,
    );

    this.lastResetDay = today;
    this.riskManager.resetDaily();
    this.dailyTradeCount = 0;
    this.dailyNetPnl = 0n;
    this.dailyWins = 0;
    this.dailyLossAlerted = false;
  }

  private async verifyBalances(base: string, quote: string): Promise<void> {
    const expectedBase = this.inventory.getAvailable(Venue.WALLET, base);
    const expectedQuote = this.inventory.getAvailable(Venue.BINANCE, quote);

    await this.syncBalances();

    const actualBase = this.inventory.getAvailable(Venue.WALLET, base);
    const actualQuote = this.inventory.getAvailable(Venue.BINANCE, quote);

    const baseDiff =
      actualBase > expectedBase ? actualBase - expectedBase : expectedBase - actualBase;
    const quoteDiff =
      actualQuote > expectedQuote ? actualQuote - expectedQuote : expectedQuote - actualQuote;

    const baseOk = baseDiff <= BASE_MISMATCH_THRESHOLD;
    const quoteOk = quoteDiff <= QUOTE_MISMATCH_THRESHOLD;

    if (!baseOk || !quoteOk) {
      logError(log, 'Balance mismatch — halting', {
        [`${base}_expected`]: fmtAmt(expectedBase),
        [`${base}_actual`]: fmtAmt(actualBase),
        [`${base}_diff`]: fmtAmt(baseDiff),
        [`${quote}_expected`]: fmtUsd(expectedQuote),
        [`${quote}_actual`]: fmtUsd(actualQuote),
        [`${quote}_diff`]: fmtUsd(quoteDiff),
      });
      void this.stop();
    }
  }

  private computeCapitalFromInventory(base: string, quote: string): bigint {
    if (!this.loadedPool || !this.baseToken || !this.quoteToken) return 0n;

    const pool = this.loadedPool;
    const baseIsToken0 = pool.token0.address.lower === this.baseToken.address.lower;
    const baseReserve = baseIsToken0 ? pool.reserve0 : pool.reserve1;
    const quoteReserve = baseIsToken0 ? pool.reserve1 : pool.reserve0;
    const baseDecimals = BigInt(this.baseToken.decimals);
    const quoteDecimals = BigInt(this.quoteToken.decimals);

    // Normalize reserves by token decimals so price is in project PRICE_SCALE (1e8).
    const basePriceUsd =
      baseReserve > 0n
        ? (quoteReserve * 10n ** baseDecimals * PRICE_SCALE) / (baseReserve * 10n ** quoteDecimals)
        : 0n;

    // Sum all base and quote holdings across both venues.
    const totalBase =
      this.inventory.getAvailable(Venue.WALLET, base) +
      this.inventory.getAvailable(Venue.BINANCE, base);
    const totalQuote =
      this.inventory.getAvailable(Venue.WALLET, quote) +
      this.inventory.getAvailable(Venue.BINANCE, quote);

    return (totalBase * basePriceUsd) / PRICE_SCALE + totalQuote;
  }

  private async syncBalances(): Promise<void> {
    const walletAddr = this.wallet.getAddress() as Hex;
    await Promise.all([
      this.exchange.fetchBalance().then((b) => this.inventory.updateFromCex(Venue.BINANCE, b)),
      this.syncWalletBalances(walletAddr),
    ]);
    const baseWallet = this.inventory.getAvailable(Venue.WALLET, this.basePair);
    const quoteWallet = this.inventory.getAvailable(Venue.WALLET, this.quotePair);
    const baseCex = this.inventory.getAvailable(Venue.BINANCE, this.basePair);
    const quoteCex = this.inventory.getAvailable(Venue.BINANCE, this.quotePair);
    log.info(
      `Balance: ` +
        `${this.basePair}@wallet: ${fmtAmt(baseWallet)}  ` +
        `${this.quotePair}@wallet: ${fmtUsd(quoteWallet)}  ` +
        `${this.basePair}@cex: ${fmtAmt(baseCex)}  ` +
        `${this.quotePair}@cex: ${fmtUsd(quoteCex)}`,
    );
  }

  private async syncWalletBalances(walletAddr: Hex): Promise<void> {
    if (!this.baseToken || !this.quoteToken) {
      // Pre-initialization: read native ETH only as a placeholder.
      const b = await this.chainClient.getBalance(new Address(walletAddr));
      const scaled = (b.raw * PRICE_SCALE) / 10n ** 18n;
      this.inventory.updateFromWallet(Venue.WALLET, { [this.basePair]: scaled });
      return;
    }
    const [baseRaw, quoteRaw] = await Promise.all([
      this.chainClient.readContract({
        address: this.botConfig.baseTokenAddress as Hex,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [walletAddr],
      }) as Promise<bigint>,
      this.chainClient.readContract({
        address: this.botConfig.quoteTokenAddress as Hex,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [walletAddr],
      }) as Promise<bigint>,
    ]);
    const baseScaled = (baseRaw * PRICE_SCALE) / 10n ** BigInt(this.baseToken.decimals);
    const quoteScaled = (quoteRaw * PRICE_SCALE) / 10n ** BigInt(this.quoteToken.decimals);
    this.inventory.updateFromWallet(Venue.WALLET, {
      [this.basePair]: baseScaled,
      [this.quotePair]: quoteScaled,
    });
  }

  private async estimateGasCostUsd(): Promise<bigint> {
    if (this.gasCache && Date.now() - this.gasCache.ts < GAS_PRICE_TTL_MS) {
      return this.gasCache.cost;
    }
    try {
      if (!this.loadedPool || !this.baseToken || !this.quoteToken) return GAS_COST_FALLBACK;

      const gasPrice = await this.chainClient.getGasPrice();
      const gasFeeWei = gasPrice.getMaxFee('medium') * SWAP_GAS_UNITS;

      const pool = this.loadedPool;
      const baseIsToken0 = pool.token0.address.lower === this.baseToken.address.lower;
      const baseReserve = baseIsToken0 ? pool.reserve0 : pool.reserve1;
      const quoteReserve = baseIsToken0 ? pool.reserve1 : pool.reserve0;
      const baseDecimals = BigInt(this.baseToken.decimals);
      const quoteDecimals = BigInt(this.quoteToken.decimals);
      if (baseReserve === 0n) return GAS_COST_FALLBACK;

      const ethPriceUsd =
        (quoteReserve * 10n ** baseDecimals * PRICE_SCALE) / (baseReserve * 10n ** quoteDecimals);
      const gasCostEthScaled = (gasFeeWei * PRICE_SCALE) / 10n ** 18n;
      const cost = (gasCostEthScaled * ethPriceUsd) / PRICE_SCALE;
      const result = cost > GAS_COST_MIN ? cost : GAS_COST_MIN;
      this.gasCache = { cost: result, ts: Date.now() };
      return result;
    } catch {
      return this.gasCache?.cost ?? GAS_COST_FALLBACK;
    }
  }

  private logRebalancePlans(): void {
    const allPlans = this.planner.planAll();
    const entries = Object.entries(allPlans);
    if (entries.length === 0) return;

    const lines: string[] = ['Rebalance recommended:'];
    for (const [asset, plans] of entries) {
      for (const p of plans) {
        const amtUsd = Number(p.amount) / PRICE_SCALE_NUM;
        const feeUsd = Number(p.estimatedFee) / PRICE_SCALE_NUM;
        const line =
          `  ${asset}: ${p.fromVenue} → ${p.toVenue}` +
          ` $${amtUsd.toFixed(2)}` +
          (p.estimatedFee > 0n ? ` (fee $${feeUsd.toFixed(2)})` : '') +
          (p.estimatedTimeMin > 0 ? ` ~${p.estimatedTimeMin}min` : '');
        log.warn(line);
        lines.push(line.trimStart());
      }
    }
    void this.telegram.send(`⚠️ ${lines.join('\n')}`, true);
  }

  private minProfitBuffer(signal: Signal): bigint {
    const configured = this.botConfig.minProfit ?? 0n;
    if (configured < 0n) return configured;
    const tradeUsd = (signal.size * signal.cexPrice) / PRICE_SCALE;
    const notional = tradeUsd / 1_000n;
    const feeBuffer = signal.expectedFees / 2n;
    const dynamic = notional > feeBuffer ? notional : feeBuffer;
    return configured > dynamic ? configured : dynamic;
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const s = this.pnl.summary();
    log.info(
      `Bot stopped — trades: ${s.totalTrades}` +
        ` | total PnL: ${fmtUsd(s.totalPnlUsd)}` +
        ` | fees paid: ${fmtUsd(s.totalFeesUsd)}` +
        ` | avg/trade: ${fmtUsd(s.avgPnlPerTrade)}` +
        ` | win rate: ${(s.winRate * 100).toFixed(0)}%`,
    );
    await this.telegram.send(
      `Bot stopped 🔴\n` +
        `Trades: ${s.totalTrades}\n` +
        `Total PnL: $${(Number(s.totalPnlUsd) / PRICE_SCALE_NUM).toFixed(2)}\n` +
        `Win rate: ${(s.winRate * 100).toFixed(0)}%`,
      true,
    );
    this.stopResolve?.();
  }
}
