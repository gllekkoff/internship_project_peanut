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
} from '@/integration/arbBot/arb_bot.constants';
import { RiskManager } from '@/safety/risk.service';
import { DEFAULT_RISK_LIMITS } from '@/safety/risk.constants';
import { absoluteSafetyCheck } from '@/safety/safety.constants';
import { isKillSwitchActive, AutoKillSwitch, writeHeartbeat } from '@/safety/kill.switch';
import { PreTradeValidator } from '@/safety/pre.trade.validator';
import { makeLogger, logTrade, logError } from '@/core/core.logger';
import { fmtUsd, fmtPrice, fmtAmt } from '@/core/core.formatters';
import { TelegramNotifier } from '@/notifications/telegram.notifier';

/** Maps on-chain token symbols to their Binance equivalents. */
function toCexSymbol(symbol: string): string {
  const MAP: Record<string, string> = {
    WETH: 'ETH',
    'USD₮0': 'USDT', // Arbitrum USDT on-chain symbol
    'USDC.e': 'USDC', // Bridged USDC on Arbitrum
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
  private readonly lastTopOfBook: Map<string, { bid: bigint; ask: bigint }> = new Map();
  private lastResetDay = new Date().getUTCDate();
  private stopResolve: (() => void) | null = null;
  private gasCache: { cost: bigint; ts: number } | null = null;
  private readonly latestBooks: Map<string, OrderBook> = new Map();

  constructor(private readonly botConfig: BotConfig) {
    this.venueProfile = getBinanceProfile(envConfig.production);
    this.exchange = new ExchangeClient(envConfig.binance, this.venueProfile);
    this.chainClient = new ChainClient([envConfig.chain.rpcUrl], 30, 3, viemChain);
    this.flashbotsChainClient = envConfig.production
      ? new ChainClient([envConfig.flashbotsRpcUrl], 30, 3, viemChain)
      : null;
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

    // FeeCalculator is finalised in initialize() once the pool's feeBps is known.
    this.fees = new FeeCalculator({
      cexTakerBps: envConfig.binance.cexFeeBps,
      dexSwapBps: 30,
      gasCost: 5n * PRICE_SCALE,
    });

    this.scorer = new SignalScorer({
      excellentSpreadBps: 100,
      minSpreadBps: botConfig.minSpreadBps,
    });
    // Capital is 0n here; setInitialCapital() is called in run() after balances are synced.
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

    // Rebuild FeeCalculator with the real pool fee now that the pool is loaded.
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
        minProfit: 0n * PRICE_SCALE,
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
        useFlashbots: envConfig.production,
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

    this.startingCapital = this.computeCapitalFromInventory(this.basePair, this.quotePair);
    this.riskManager.setInitialCapital(this.startingCapital);
    log.info(
      `Initial capital: ${fmtUsd(this.startingCapital)} (${this.basePair} wallet + ${this.quotePair} CEX)`,
    );

    this.exchange.subscribeDepth(this.activePair, (book) => {
      this.latestBooks.set(this.activePair, book);
      void this.tick(this.activePair, book);
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
    await this.telegram.sendControlPanel(
      `Bot started ✅\n` +
        `Pair: ${this.activePair}\n` +
        `Mode: ${mode}\n\n` +
        `Wallet: ${fmtAmt(walletBase)} ${this.basePair}\n` +
        `CEX: ${fmtUsd(cexQuote)} ${this.quotePair}\n` +
        `Total capital: ${fmtUsd(this.startingCapital)}\n\n` +
        `Use /stop or the button below to shut down.`,
    );

    const balanceTimer = setInterval(() => {
      void this.syncBalances();
    }, BALANCE_SYNC_INTERVAL_MS);

    const resetTimer = setInterval(() => {
      this.maybeDailyReset();
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
    const prev = this.lastTopOfBook.get(pair);
    const bid = book.bestBid[0];
    const ask = book.bestAsk[0];
    if (prev && prev.bid === bid && prev.ask === ask) return;
    this.lastTopOfBook.set(pair, { bid, ask });

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
      this.autoKill.recordError();
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
      log.warn(`  → Pre-trade validation failed: ${preCheck.reason}`);
      return null;
    }

    const [base = '', quote = ''] = pair.split('/');
    const checks = this.planner.checkAll();
    log.info(
      `  balance: ${base}@wallet = ${fmtAmt(this.inventory.getAvailable(Venue.WALLET, base))}` +
        `  ${quote}@cex = ${fmtUsd(this.inventory.getAvailable(Venue.BINANCE, quote))}`,
    );
    for (const check of checks) {
      if (check.needsRebalance && (check.asset === base || check.asset === quote)) {
        log.warn(
          `  → Rebalance needed: ${check.asset} skew = ${check.maxDeviationPct.toFixed(1)}%`,
        );
      }
    }

    const rawScore = this.scorer.score(signal, checks);
    const score = this.scorer.applyDecay(signal, rawScore);
    const size = Number(signal.size) / PRICE_SCALE_NUM;
    log.info(`Signal [${signal.signalId}] ${pair} ${size} ${base} — ${signal.direction}`);
    log.info(
      `  prices : cex = ${fmtPrice(signal.cexPrice)}  dex = ${fmtPrice(signal.dexPrice)}  spread = ${signal.spreadBps.toFixed(1)}bps`,
    );
    log.info(
      `  pnl    : gross = ${fmtUsd(signal.expectedGrossPnl)}  fees = ${fmtUsd(signal.expectedFees)}  net = ${fmtUsd(signal.expectedNetPnl)}`,
    );
    log.info(
      `  score  : ${score.toFixed(0)} (raw = ${rawScore.toFixed(1)}, threshold = ${this.botConfig.minScore})`,
    );

    if (score < this.botConfig.minScore) {
      log.info('  → Skipped: score below threshold');
      return null;
    }

    const minProfit = this.minProfitBuffer(signal);
    if (signal.expectedNetPnl < minProfit) {
      log.info(
        `  → Skipped: net PnL ${fmtUsd(signal.expectedNetPnl)} below buffer ${fmtUsd(minProfit)}`,
      );
      return null;
    }

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
    const size = Number(signal.size) / PRICE_SCALE_NUM;
    log.info(
      `DRY RUN | Would trade: ${signal.pair} ${signal.direction}` +
        ` size = ${size.toFixed(4)} spread = ${signal.spreadBps.toFixed(1)}bps` +
        ` expected_pnl = ${fmtUsd(signal.expectedNetPnl)}`,
    );
    this.riskManager.recordTrade(signal.expectedNetPnl);
    this.pnl.record(signalToArbRecord(signal));
    const summary = this.pnl.summary();
    void this.telegram.send(
      `[DRY RUN] Would trade: ${signal.pair} ${signal.direction}\n` +
        `Size: ${size.toFixed(4)} ETH | Spread: ${signal.spreadBps.toFixed(1)}bps\n` +
        `Expected PnL: ${fmtUsd(signal.expectedNetPnl)}\n` +
        `Session: ${summary.totalTrades} signals | total ${fmtUsd(summary.totalPnlUsd)}`,
    );
  }

  private async executeReal(signal: Signal, pair: string, book: OrderBook): Promise<void> {
    const [base = '', quote = ''] = pair.split('/');
    const minProfit = this.minProfitBuffer(signal);
    const size = Number(signal.size) / PRICE_SCALE_NUM;

    const freshSignal = await this.generator.peek(pair, this.latestBooks.get(pair) ?? book);
    if (!freshSignal || freshSignal.expectedNetPnl < minProfit) {
      log.info('  → Skipped: opportunity gone by execution time');
      return;
    }

    log.info(`  → Executing ${size} ${base}`);
    const ctx = await this.executor.execute(signal);
    this.scorer.recordResult(pair, ctx.state === ExecutorState.DONE);

    if (ctx.state === ExecutorState.DONE) {
      const netPnl = ctx.actualNetPnlUsd ?? 0n;
      this.riskManager.recordTrade(netPnl);
      this.pnl.record(executionToArbRecord(ctx));
      const summary = this.pnl.summary();
      const risk = this.riskManager.status();
      logTrade(log, {
        pair: signal.pair,
        direction: signal.direction,
        size: Number(signal.size) / PRICE_SCALE_NUM,
        spreadBps: Number(signal.spreadBps),
        pnlUsd: Number(netPnl) / PRICE_SCALE_NUM,
        state: ctx.state,
      });
      log.info(
        `session: trades = ${summary.totalTrades} pnl = ${fmtUsd(summary.totalPnlUsd)} win = ${(summary.winRate * 100).toFixed(0)}%` +
          ` | risk: daily = ${risk.dailyPnlUsd.toFixed(2)} drawdown = ${risk.drawdownPct.toFixed(1)}%`,
      );
      const pnlUsd = Number(netPnl) / PRICE_SCALE_NUM;
      void this.telegram.send(
        `Trade completed: ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)}\n` +
          `Pair: ${signal.pair} | ${signal.direction}\n` +
          `Session: ${summary.totalTrades} trades | total $${(Number(summary.totalPnlUsd) / PRICE_SCALE_NUM).toFixed(2)}`,
      );
    } else {
      logTrade(log, {
        pair: signal.pair,
        direction: signal.direction,
        size: Number(signal.size) / PRICE_SCALE_NUM,
        spreadBps: Number(signal.spreadBps),
        pnlUsd: 0,
        state: ctx.state,
      });
      if (ctx.error === 'Circuit breaker open') {
        void this.telegram.send(`Circuit breaker tripped!\nPair: ${signal.pair}`, true);
      }
    }

    await this.verifyBalances(base, quote);
    const baseAfter = this.inventory.getAvailable(Venue.WALLET, base);
    const quoteAfter = this.inventory.getAvailable(Venue.BINANCE, quote);
    log.info(
      `  post-trade: ${base}@wallet=${fmtAmt(baseAfter)}  ${quote}@cex=${fmtUsd(quoteAfter)}`,
    );
    for (const check of this.planner.checkAll()) {
      if (check.needsRebalance && (check.asset === base || check.asset === quote)) {
        const bal =
          check.asset === base
            ? `${fmtAmt(this.inventory.getAvailable(Venue.WALLET, base))}@wallet`
            : `${fmtUsd(this.inventory.getAvailable(Venue.BINANCE, quote))}@cex`;
        log.warn(
          `  → Rebalance needed: ${check.asset}=${bal} skew=${check.maxDeviationPct.toFixed(1)}%`,
        );
      }
    }
  }

  private onTradeUpdate(pair: string, trade: TradeEvent): void {
    const sizeEth = Number(trade.quantity) / PRICE_SCALE_NUM;
    if (sizeEth >= 5) {
      const side = trade.isBuyerMaker ? 'SELL' : 'BUY';
      log.info(`Trade [${pair}] ${side} ${sizeEth.toFixed(3)} @ ${fmtPrice(trade.price)}`);
    }
  }

  private maybeDailyReset(): void {
    const today = new Date().getUTCDate();
    if (today !== this.lastResetDay) {
      this.lastResetDay = today;
      this.riskManager.resetDaily();
      this.dailyLossAlerted = false;
      log.info('Daily risk counters reset');
    }
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
    const baseBalance = this.inventory.getAvailable(Venue.WALLET, base);
    const cexQuote = this.inventory.getAvailable(Venue.BINANCE, quote);

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
    const baseValueUsd = (baseBalance * basePriceUsd) / PRICE_SCALE;
    return baseValueUsd + cexQuote;
  }

  private async syncBalances(): Promise<void> {
    const walletAddr = this.wallet.getAddress() as Hex;
    await Promise.all([
      this.exchange.fetchBalance().then((b) => this.inventory.updateFromCex(Venue.BINANCE, b)),
      this.syncWalletBalances(walletAddr),
    ]);
    const base = this.inventory.getAvailable(Venue.WALLET, this.basePair);
    const quote = this.inventory.getAvailable(Venue.BINANCE, this.quotePair);
    log.info(
      `balance: ${this.basePair}@wallet = ${fmtAmt(base)}  ${this.quotePair}@cex = ${fmtUsd(quote)}`,
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
    const GAS_UNITS = 180_000n;
    const CACHE_TTL_MS = 30_000;
    const FALLBACK = 5n * PRICE_SCALE;
    const MIN_GAS = 2n * PRICE_SCALE;

    if (this.gasCache && Date.now() - this.gasCache.ts < CACHE_TTL_MS) {
      return this.gasCache.cost;
    }
    try {
      if (!this.loadedPool || !this.baseToken || !this.quoteToken) return FALLBACK;

      const gasPrice = await this.chainClient.getGasPrice();
      const gasFeeWei = gasPrice.getMaxFee('medium') * GAS_UNITS;

      const pool = this.loadedPool;
      const baseIsToken0 = pool.token0.address.lower === this.baseToken.address.lower;
      const baseReserve = baseIsToken0 ? pool.reserve0 : pool.reserve1;
      const quoteReserve = baseIsToken0 ? pool.reserve1 : pool.reserve0;
      const baseDecimals = BigInt(this.baseToken.decimals);
      const quoteDecimals = BigInt(this.quoteToken.decimals);
      if (baseReserve === 0n) return FALLBACK;

      const ethPriceUsd =
        (quoteReserve * 10n ** baseDecimals * PRICE_SCALE) / (baseReserve * 10n ** quoteDecimals);
      const gasCostEthScaled = (gasFeeWei * PRICE_SCALE) / 10n ** 18n;
      const cost = (gasCostEthScaled * ethPriceUsd) / PRICE_SCALE;
      const result = cost > MIN_GAS ? cost : MIN_GAS;
      this.gasCache = { cost: result, ts: Date.now() };
      return result;
    } catch {
      return this.gasCache?.cost ?? FALLBACK;
    }
  }

  private minProfitBuffer(signal: Signal): bigint {
    const tradeUsd = (signal.size * signal.cexPrice) / PRICE_SCALE;
    const fixed = 3n * PRICE_SCALE;
    const notional = tradeUsd / 1_000n;
    const feeBuffer = signal.expectedFees / 2n;
    return fixed > notional
      ? fixed > feeBuffer
        ? fixed
        : feeBuffer
      : notional > feeBuffer
        ? notional
        : feeBuffer;
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
