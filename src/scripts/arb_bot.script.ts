#!/usr/bin/env tsx
/**
 * Arb bot main loop — signal generation → scoring → execution.
 *
 * Usage:
 *   npx tsx src/scripts/arb_bot.script.ts [--dry-run] [--no-dex]
 *
 * Flags:
 *   --dry-run   Simulate both legs (no real orders sent to Binance).
 *   --no-dex    Skip Uniswap pool loading; use simulated DEX prices centred on
 *               CEX mid. Use this when running against Sepolia/testnet where
 *               mainnet Uniswap pools are unavailable.
 *
 * Required env: MAINNET_RPC_URL, PRIVATE_KEY
 * Optional env: BINANCE_TESTNET_API_KEY, BINANCE_TESTNET_SECRET,
 *               FORK_RPC_URL (default: http://127.0.0.1:8545),
 *               FORK_WS_URL  (default: ws://127.0.0.1:8546)
 */
import { config as envConfig } from '@/configs/configs.service';
import { Address } from '@/core/core.types';
import type { Token } from '@/core/core.types';
import { WalletManager } from '@/core/wallet.service';
import { ChainClient } from '@/chain/chain.client';
import { ExchangeClient } from '@/exchange/cexClient/exchange.client';
import { PRICE_SCALE, PRICE_SCALE_NUM } from '@/core/core.constants';
import { UniswapV2Pair } from '@/pricing/uniswap-v2/uniswap-v2.service';
import { PricingEngine } from '@/pricing/engine/engine.service';
import { BINANCE_PROFILE } from '@/venues/binance/binance.profile';
import { VenueHydrator } from '@/venues/venue.hydrator';
import { InventoryTracker } from '@/inventory/tracker/tracker.service';
import { RebalancePlanner } from '@/inventory/rebalancer/rebalancer.service';
import { PnLEngine } from '@/inventory/pnl/pnl.service';
import { ArbRecord, TradeLeg } from '@/inventory/pnl/pnl.interfaces';
import { Venue } from '@/inventory/tracker/tracker.interfaces';
import { FeeCalculator } from '@/strategy/fee.calculator';
import { SignalGenerator } from '@/strategy/signal.generator';
import { SignalScorer } from '@/strategy/scorer/scorer.service';
import { Executor } from '@/executor/engine/engine.service';
import { ExecutorState, type ExecutionContext } from '@/executor/engine/engine.interfaces';

// ── Constants ──────────────────────────────────────────────────────────────────

// Uniswap V2 USDC/WETH pool — the DEX liquidity source for ETH/USDT signals.
const USDC_WETH_POOL = new Address('0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc');
const FORK_RPC_URL = process.env['FORK_RPC_URL'] ?? 'http://127.0.0.1:8545';
const FORK_WS_URL = process.env['FORK_WS_URL'] ?? 'ws://127.0.0.1:8546';

// ── Logger ─────────────────────────────────────────────────────────────────────

const log = {
  info: (msg: string) => console.log(`${ts()} INFO  ${msg}`),
  warn: (msg: string) => console.warn(`${ts()} WARN  ${msg}`),
  error: (msg: string) => console.error(`${ts()} ERROR ${msg}`),
};

function ts(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function fmtUsd(v: bigint): string {
  return `$${(Number(v) / PRICE_SCALE_NUM).toFixed(2)}`;
}

function fmtPrice(v: bigint): string {
  return `$${(Number(v) / PRICE_SCALE_NUM).toFixed(4)}`;
}

// ── Bridge ─────────────────────────────────────────────────────────────────────

/** Converts a completed ExecutionContext into an ArbRecord the PnLEngine can track. */
function executionToArbRecord(ctx: ExecutionContext): ArbRecord {
  const { signal } = ctx;
  const [, quote = 'USDT'] = signal.pair.split('/');

  const buyVenue = ctx.leg1Venue === 'cex' ? Venue.BINANCE : Venue.WALLET;
  const sellVenue = ctx.leg2Venue === 'dex' ? Venue.WALLET : Venue.BINANCE;

  const buyLeg = new TradeLeg(
    `${signal.signalId}_buy`,
    ctx.startedAt,
    buyVenue,
    signal.pair,
    'buy',
    ctx.leg1FillSize ?? 0n,
    ctx.leg1FillPrice ?? 0n,
    0n,
    quote,
  );

  const sellLeg = new TradeLeg(
    `${signal.signalId}_sell`,
    ctx.finishedAt ?? ctx.startedAt,
    sellVenue,
    signal.pair,
    'sell',
    ctx.leg2FillSize ?? 0n,
    ctx.leg2FillPrice ?? 0n,
    0n,
    quote,
  );

  return new ArbRecord(signal.signalId, ctx.startedAt, buyLeg, sellLeg);
}

// ── BotConfig ──────────────────────────────────────────────────────────────────

interface BotConfig {
  readonly pairs: string[];
  readonly tradeSize: bigint;
  readonly tickMs: number;
  readonly minScore: number;
  readonly simulationMode: boolean;
  /** When true, skip Uniswap pool loading and use simulated DEX prices. */
  readonly noDex: boolean;
}

// ── ArbBot ─────────────────────────────────────────────────────────────────────

/** Orchestrates the full arb pipeline: sync → generate → score → execute → record. */
class ArbBot {
  private readonly exchange: ExchangeClient;
  private readonly chainClient: ChainClient;
  private readonly pricingEngine: PricingEngine | null;
  private readonly inventory: InventoryTracker;
  private readonly planner: RebalancePlanner;
  private readonly pnl: PnLEngine;
  private readonly fees: FeeCalculator;
  private readonly scorer: SignalScorer;
  private readonly executor: Executor;
  private readonly wallet: ReturnType<typeof WalletManager.from_env>;

  // Initialized asynchronously in initialize() before the loop starts.
  private generator!: SignalGenerator;

  private running = false;

  constructor(private readonly botConfig: BotConfig) {
    this.exchange = new ExchangeClient(envConfig.binance, BINANCE_PROFILE);
    this.chainClient = new ChainClient([envConfig.chain.mainnetRpcUrl]);
    this.pricingEngine = botConfig.noDex
      ? null
      : new PricingEngine(this.chainClient, FORK_RPC_URL, FORK_WS_URL);
    this.wallet = WalletManager.from_env('PRIVATE_KEY');

    this.inventory = new InventoryTracker([Venue.BINANCE, Venue.WALLET]);
    this.planner = new RebalancePlanner(this.inventory, BINANCE_PROFILE);
    this.pnl = new PnLEngine();

    this.fees = new FeeCalculator({
      cexTakerBps: 10,
      dexSwapBps: 30,
      gasCost: 5n * PRICE_SCALE,
    });

    this.scorer = new SignalScorer({ excellentSpreadBps: 100, minSpreadBps: 30 });

    this.executor = new Executor(
      this.exchange,
      this.pricingEngine,
      this.inventory,
      BINANCE_PROFILE,
      {
        simulationMode: botConfig.simulationMode,
        useFlashbots: false,
      },
    );
  }

  /**
   * Hydrates the venue profile with live fees, then optionally loads pool reserves
   * from chain and builds SignalGenerator with real DEX pricing.
   * When noDex is set, skips pool loading and uses simulated DEX prices instead.
   */
  private async initialize(): Promise<void> {
    log.info('Hydrating venue profile...');
    const hydrator = new VenueHydrator();
    await hydrator
      .hydrate(BINANCE_PROFILE, this.exchange)
      .catch((e) => log.warn(`VenueHydrator failed — using static defaults: ${String(e)}`));

    let pairTokens: Map<string, readonly [Token, Token]> | undefined;

    if (this.pricingEngine !== null) {
      log.info('Loading pool data from chain...');
      const [pool] = await Promise.all([
        UniswapV2Pair.fromChain(USDC_WETH_POOL, this.chainClient),
        this.pricingEngine.loadPools([USDC_WETH_POOL]),
      ]);
      const weth: Token = pool.token0.symbol.startsWith('WETH') ? pool.token0 : pool.token1;
      const usdc: Token = weth === pool.token0 ? pool.token1 : pool.token0;
      pairTokens = new Map([['ETH/USDT', [weth, usdc] as const]]);
      log.info(`Pool loaded: ${pool.token0.symbol}/${pool.token1.symbol}`);

      await this.pricingEngine.startMonitor();
      log.info('Mempool monitor started');
    } else {
      log.info('--no-dex: skipping pool load, using simulated DEX prices');
    }

    const senderAddress = new Address(this.wallet.getAddress());

    this.generator = new SignalGenerator(
      this.exchange,
      this.pricingEngine,
      this.inventory,
      this.fees,
      {
        minSpreadBps: 30,
        minProfit: 2n * PRICE_SCALE,
        maxPosition: 20_000n * PRICE_SCALE,
        cooldownMs: this.botConfig.tickMs,
        senderAddress,
        ...(pairTokens !== undefined && { pairTokens }),
      },
      this.chainClient,
    );
  }

  /** Starts the polling loop; runs until stop() is called or process is interrupted. */
  async run(): Promise<void> {
    this.running = true;
    log.info('Bot starting...');

    await this.exchange.connect();
    await this.syncBalances();

    if (this.botConfig.noDex || this.botConfig.simulationMode) {
      // When DEX is simulated there is no real on-chain execution, so wallet balances are irrelevant.
      // Seed enough to pass the inventory check without touching the real CEX balances.
      this.inventory.updateFromWallet(Venue.WALLET, {
        ETH: 100n * PRICE_SCALE,
        USDT: 100_000n * PRICE_SCALE,
      });
      log.info('No-DEX/dry-run: seeded demo wallet balances — 100 ETH + 100k USDT at WALLET');
    }

    await this.initialize();

    while (this.running) {
      try {
        await this.tick();
      } catch (e) {
        log.error(`Tick error: ${e instanceof Error ? e.message : String(e)}`);
        await new Promise((r) => setTimeout(r, 5_000));
        continue;
      }
      await new Promise((r) => setTimeout(r, this.botConfig.tickMs));
    }
  }

  /** Processes one polling cycle across all configured pairs. */
  private async tick(): Promise<void> {
    await this.syncBalances();
    const checks = this.planner.checkAll();

    for (const pair of this.botConfig.pairs) {
      const signal = await this.generator.generate(pair, this.botConfig.tradeSize);
      if (signal === null) continue;

      const rawScore = this.scorer.score(signal, checks);
      // Decay the composite score linearly as the signal ages toward its TTL.
      const score = this.scorer.applyDecay(signal, rawScore);
      const size = Number(this.botConfig.tradeSize) / PRICE_SCALE_NUM;
      log.info(`Signal [${signal.signalId}] ${pair} ${size} ETH — ${signal.direction}`);
      log.info(
        `  prices : cex=${fmtPrice(signal.cexPrice)}  dex=${fmtPrice(signal.dexPrice)}  spread=${signal.spreadBps.toFixed(1)}bps`,
      );
      log.info(
        `  pnl    : gross=${fmtUsd(signal.expectedGrossPnl)}  fees=${fmtUsd(signal.expectedFees)}  net=${fmtUsd(signal.expectedNetPnl)}`,
      );
      log.info(
        `  score  : ${score.toFixed(1)} (raw=${rawScore.toFixed(1)}, threshold=${this.botConfig.minScore})`,
      );

      if (score < this.botConfig.minScore) {
        log.info('  → Skipped: score below threshold');
        continue;
      }

      log.info(`  → Executing ${size} ${pair.split('/')[0]}`);

      const ctx = await this.executor.execute(signal);
      this.scorer.recordResult(pair, ctx.state === ExecutorState.DONE);

      if (ctx.state === ExecutorState.DONE) {
        this.pnl.record(executionToArbRecord(ctx));
        const summary = this.pnl.summary();
        log.info(
          `SUCCESS | actual net=${fmtUsd(ctx.actualNetPnlUsd ?? 0n)}` +
            ` | session: trades=${summary.totalTrades} pnl=${fmtUsd(summary.totalPnlUsd)} win=${(summary.winRate * 100).toFixed(0)}%`,
        );
      } else {
        log.warn(`FAILED: ${ctx.error}`);
      }

      await this.syncBalances();
    }
  }

  /** Fetches and updates CEX balances. Wallet sync is skipped when DEX is not real (no mainnet ETH needed). */
  private async syncBalances(): Promise<void> {
    const tasks: Promise<unknown>[] = [
      this.exchange.fetchBalance().then((b) => this.inventory.updateFromCex(Venue.BINANCE, b)),
    ];
    if (!this.botConfig.noDex && !this.botConfig.simulationMode) {
      tasks.push(
        this.chainClient
          .getBalance(new Address(this.wallet.getAddress()))
          .then((b) => this.inventory.updateFromWallet(Venue.WALLET, { ETH: b.raw / 10n ** 10n })),
      );
    }
    await Promise.allSettled(tasks);
  }

  /** Stops the polling loop after the current tick completes. */
  stop(): void {
    this.running = false;
    const s = this.pnl.summary();
    log.info(
      `Bot stopped — trades: ${s.totalTrades}` +
        ` | total PnL: ${fmtUsd(s.totalPnlUsd)}` +
        ` | fees paid: ${fmtUsd(s.totalFeesUsd)}` +
        ` | avg/trade: ${fmtUsd(s.avgPnlPerTrade)}` +
        ` | win rate: ${(s.winRate * 100).toFixed(0)}%`,
    );
  }
}

// ── Entry point ────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run');
const NO_DEX = process.argv.includes('--no-dex');

const bot = new ArbBot({
  pairs: ['ETH/USDT'],
  tradeSize: BigInt(Math.round(0.1 * PRICE_SCALE_NUM)),
  tickMs: 1_000,
  minScore: 60,
  simulationMode: DRY_RUN,
  noDex: NO_DEX,
});

process.on('SIGINT', () => {
  bot.stop();
  process.exit(0);
});

await bot.run();
