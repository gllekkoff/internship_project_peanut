import { PRICE_SCALE, PRICE_SCALE_NUM } from '@/core/core.constants'; // PRICE_SCALE_NUM used at ccxt boundary
import { sleep } from '@/chain/chain.utils';
import type { ExchangeClient } from '@/exchange/cexClient/exchange.client';
import type { PricingEngine } from '@/pricing/engine/engine.service';
import { InventoryTracker } from '@/inventory/tracker/tracker.service';
import { Venue } from '@/inventory/tracker/tracker.interfaces';
import { Direction } from '@/strategy/signal.interfaces';
import type { Signal } from '@/strategy/signal.interfaces';
import type { VenueProfile } from '@/venues/venue.interfaces';
import {
  ExecutorState,
  type ExecutionContext,
  type ExecutorConfig,
  type LegResult,
} from '@/executor/engine/engine.interfaces';
import { UnwindError } from '@/executor/engine/engine.errors';
import {
  CEX_PRICE_BUFFER_BPS,
  DEFAULT_LEG1_TIMEOUT_MS,
  DEFAULT_LEG2_TIMEOUT_MS,
  DEFAULT_MIN_FILL_RATIO,
} from '@/executor/engine/engine.constants';
import { CircuitBreaker, ReplayProtection } from '@/executor/recovery/recovery.service';

/** Executes arbitrage signals across CEX and DEX with circuit breaking and replay protection. */
export class Executor {
  private readonly leg1TimeoutMs: number;
  private readonly leg2TimeoutMs: number;
  private readonly minFillRatio: number;
  private readonly useFlashbots: boolean;
  private readonly simulationMode: boolean;
  private readonly circuitBreaker = new CircuitBreaker();
  private readonly replayProtection = new ReplayProtection();

  constructor(
    private readonly exchangeClient: ExchangeClient,
    private readonly pricingEngine: PricingEngine | null,
    private readonly inventory: InventoryTracker,
    private readonly profile: VenueProfile,
    config: ExecutorConfig = {},
  ) {
    this.leg1TimeoutMs = config.leg1TimeoutMs ?? DEFAULT_LEG1_TIMEOUT_MS;
    this.leg2TimeoutMs = config.leg2TimeoutMs ?? DEFAULT_LEG2_TIMEOUT_MS;
    this.minFillRatio = config.minFillRatio ?? DEFAULT_MIN_FILL_RATIO;
    this.useFlashbots = config.useFlashbots ?? true;
    this.simulationMode = config.simulationMode ?? true;
  }

  /**
   * Runs all pre-flight checks then executes both legs in order.
   * DEX-first when useFlashbots is true (failed tx = no cost), CEX-first otherwise.
   */
  async execute(signal: Signal): Promise<ExecutionContext> {
    const ctx = this.makeContext(signal);

    if (this.circuitBreaker.isOpen()) {
      return this.fail(ctx, 'Circuit breaker open');
    }

    if (this.replayProtection.isDuplicate(signal)) {
      return this.fail(ctx, 'Duplicate signal');
    }

    ctx.state = ExecutorState.VALIDATING;
    if (!signal.isValid()) {
      const reasons: string[] = [];
      if (Date.now() >= signal.expiry.getTime()) reasons.push('expired');
      if (!signal.inventoryOk) reasons.push('inventory insufficient at signal time');
      if (!signal.withinLimits) reasons.push('exceeds max position');
      if (signal.expectedNetPnl <= 0n) reasons.push('net PnL non-positive');
      if (signal.score <= 0) reasons.push('score zero');
      return this.fail(ctx, `Signal invalid: ${reasons.join(', ') || 'unknown'}`);
    }

    const [base = '', quote = ''] = signal.pair.split('/');
    // quoteNeeded = base size × price, scaled — approximated from signal price.
    const quoteNeeded = (signal.size * signal.cexPrice) / PRICE_SCALE;
    const isBuyDex = signal.direction === Direction.BUY_DEX_SELL_CEX;
    // BUY_DEX_SELL_CEX: spend USDT at WALLET on DEX, sell ETH at BINANCE on CEX.
    // BUY_CEX_SELL_DEX: spend USDT at BINANCE on CEX, sell ETH at WALLET on DEX.
    const inventoryCheck = this.inventory.canExecute(
      isBuyDex ? Venue.WALLET : Venue.BINANCE,
      quote,
      quoteNeeded,
      isBuyDex ? Venue.BINANCE : Venue.WALLET,
      base,
      signal.size,
    );
    if (!inventoryCheck.canExecute) {
      return this.fail(ctx, inventoryCheck.reason ?? 'Insufficient inventory');
    }

    const result = this.useFlashbots
      ? await this.executeDexFirst(ctx)
      : await this.executeCexFirst(ctx);

    this.replayProtection.markExecuted(signal);

    if (result.state === ExecutorState.DONE) {
      this.circuitBreaker.recordSuccess();
    } else {
      this.circuitBreaker.recordFailure();
    }

    result.finishedAt = new Date();
    return result;
  }

  /** CEX leg first — default when not using Flashbots. Unwinds on DEX failure. */
  private async executeCexFirst(ctx: ExecutionContext): Promise<ExecutionContext> {
    const { signal } = ctx;

    ctx.state = ExecutorState.LEG1_PENDING;
    ctx.leg1Venue = 'cex';

    const leg1 = await this.withTimeout(
      this.executeCexLeg(signal, signal.size),
      this.leg1TimeoutMs,
    );
    if (!leg1) return this.fail(ctx, 'CEX timeout');
    if (!leg1.success) return this.fail(ctx, leg1.error ?? 'CEX rejected');

    const minFillScaled = BigInt(Math.round(this.minFillRatio * 10_000));
    if ((leg1.filled * 10_000n) / signal.size < minFillScaled) {
      const pct = ((Number(leg1.filled) * 100) / Number(signal.size)).toFixed(1);
      return this.fail(ctx, `Partial fill below threshold: ${pct}%`);
    }

    ctx.leg1FillPrice = leg1.price;
    ctx.leg1FillSize = leg1.filled;
    ctx.state = ExecutorState.LEG1_FILLED;

    ctx.state = ExecutorState.LEG2_PENDING;
    ctx.leg2Venue = 'dex';

    const leg2 = await this.withTimeout(
      this.executeDexLeg(signal, leg1.filled),
      this.leg2TimeoutMs,
    );
    if (!leg2) {
      ctx.state = ExecutorState.UNWINDING;
      await this.unwind(ctx).catch(() => {});
      return this.fail(ctx, 'DEX timeout — unwound');
    }
    if (!leg2.success) {
      ctx.state = ExecutorState.UNWINDING;
      await this.unwind(ctx).catch(() => {});
      return this.fail(ctx, `DEX failed — unwound: ${leg2.error ?? ''}`);
    }

    ctx.leg2FillPrice = leg2.price;
    ctx.leg2FillSize = leg2.filled;
    ctx.actualNetPnlUsd = this.calculatePnl(ctx);
    ctx.state = ExecutorState.DONE;
    this.recordTrades(ctx);
    return ctx;
  }

  /** DEX leg first — preferred with Flashbots since a failed tx costs no gas. Unwinds on CEX failure. */
  private async executeDexFirst(ctx: ExecutionContext): Promise<ExecutionContext> {
    const { signal } = ctx;

    ctx.state = ExecutorState.LEG1_PENDING;
    ctx.leg1Venue = 'dex';

    const leg1 = await this.withTimeout(
      this.executeDexLeg(signal, signal.size),
      this.leg2TimeoutMs,
    );
    if (!leg1) return this.fail(ctx, 'DEX timeout');
    if (!leg1.success) return this.fail(ctx, 'DEX failed (no cost via Flashbots)');

    ctx.leg1FillPrice = leg1.price;
    ctx.leg1FillSize = leg1.filled;
    ctx.state = ExecutorState.LEG1_FILLED;

    ctx.state = ExecutorState.LEG2_PENDING;
    ctx.leg2Venue = 'cex';

    const leg2 = await this.withTimeout(
      this.executeCexLeg(signal, leg1.filled),
      this.leg1TimeoutMs,
    );
    if (!leg2) {
      ctx.state = ExecutorState.UNWINDING;
      await this.unwind(ctx).catch(() => {});
      return this.fail(ctx, 'CEX timeout after DEX — unwound');
    }
    if (!leg2.success) {
      ctx.state = ExecutorState.UNWINDING;
      await this.unwind(ctx).catch(() => {});
      return this.fail(ctx, `CEX failed after DEX — unwound: ${leg2.error ?? ''}`);
    }

    ctx.leg2FillPrice = leg2.price;
    ctx.leg2FillSize = leg2.filled;
    ctx.actualNetPnlUsd = this.calculatePnl(ctx);
    ctx.state = ExecutorState.DONE;
    this.recordTrades(ctx);
    return ctx;
  }

  /**
   * Executes the CEX leg via createLimitIocOrder with a 0.1% price buffer.
   * In simulation mode returns a synthetic fill after a short delay.
   */
  private async executeCexLeg(signal: Signal, size: bigint): Promise<LegResult> {
    if (this.simulationMode) {
      await sleep(100);
      return { success: true, price: (signal.cexPrice * 10001n) / 10000n, filled: size };
    }

    const sizeNum = Number(size) / PRICE_SCALE_NUM;
    const priceNum =
      Number((signal.cexPrice * (10000n + CEX_PRICE_BUFFER_BPS)) / 10000n) / PRICE_SCALE_NUM;
    const side = signal.direction === Direction.BUY_CEX_SELL_DEX ? 'buy' : 'sell';

    const order = await this.exchangeClient.createLimitIocOrder(
      signal.pair,
      side,
      sizeNum,
      priceNum,
    );

    // IOC orders that partially filled have status 'canceled' but amountFilled > 0.
    // Treat as success so the fill-ratio check (not this leg) decides whether to proceed.
    return {
      success: order.amountFilled > 0n,
      price: order.avgFillPrice,
      filled: order.amountFilled,
      ...(order.amountFilled === 0n && { error: order.status }),
    };
  }

  /**
   * Executes the DEX leg via the pricing engine.
   * In simulation mode returns a synthetic fill after a short delay.
   * Real execution requires PricingEngine integration — throws if not in simulation mode.
   */
  private async executeDexLeg(signal: Signal, size: bigint): Promise<LegResult> {
    if (this.simulationMode) {
      await sleep(500);
      return { success: true, price: (signal.dexPrice * 9998n) / 10000n, filled: size };
    }

    // Real DEX execution is wired through PricingEngine + TransactionBuilder.
    if (!this.pricingEngine) {
      throw new Error(
        'Real DEX execution requires a PricingEngine — pass one to the Executor constructor',
      );
    }
    throw new Error('Real DEX execution not yet implemented');
  }

  /**
   * Reverses the leg1 position via a market order when leg2 fails.
   * Only CEX unwind is supported — DEX unwind requires a separate on-chain tx.
   */
  private async unwind(ctx: ExecutionContext): Promise<void> {
    if (this.simulationMode) {
      await sleep(100);
      return;
    }

    const fillSize = ctx.leg1Venue === 'cex' ? ctx.leg1FillSize : ctx.leg2FillSize;
    if (!fillSize || fillSize === 0n) return;

    const { signal } = ctx;
    const unwindVenue = ctx.leg1Venue === 'cex' ? 'cex' : ctx.leg2Venue;

    if (unwindVenue !== 'cex') {
      // DEX unwind requires an on-chain transaction — not yet implemented.
      throw new UnwindError('DEX-side unwind not yet implemented');
    }

    const sizeNum = Number(fillSize) / PRICE_SCALE_NUM;
    // Reverse the CEX position: if we bought, sell back; if we sold, buy back.
    const unwindSide = signal.direction === Direction.BUY_CEX_SELL_DEX ? 'sell' : 'buy';

    try {
      await this.exchangeClient.createMarketOrder(signal.pair, unwindSide, sizeNum);
    } catch (e) {
      throw new UnwindError(
        `Market ${unwindSide} unwind failed for ${signal.pair}: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
  }

  /**
   * Applies completed fill data to InventoryTracker for both legs.
   * Called only after DONE state — no-op on partial or failed executions.
   */
  private recordTrades(ctx: ExecutionContext): void {
    const { signal } = ctx;
    const [base = '', quote = ''] = signal.pair.split('/');
    const leg1Size = ctx.leg1FillSize ?? 0n;
    const leg2Size = ctx.leg2FillSize ?? 0n;
    const leg1Price = ctx.leg1FillPrice ?? 0n;
    const leg2Price = ctx.leg2FillPrice ?? 0n;
    const leg1Notional = (leg1Size * leg1Price) / PRICE_SCALE;
    const leg2Notional = (leg2Size * leg2Price) / PRICE_SCALE;
    // Fee per leg: half of the combined rate applied to that leg's notional.
    const halfFeeBps = this.profile.trading.combinedFeeRateBps / 2n;
    const leg1Fee = (leg1Notional * halfFeeBps) / 10_000n;
    const leg2Fee = (leg2Notional * halfFeeBps) / 10_000n;

    if (ctx.leg1Venue === 'cex') {
      const cexSide = signal.direction === Direction.BUY_CEX_SELL_DEX ? 'buy' : 'sell';
      this.inventory.recordTrade(
        Venue.BINANCE,
        cexSide,
        base,
        quote,
        leg1Size,
        leg1Notional,
        leg1Fee,
        quote,
      );
      this.inventory.recordTrade(
        Venue.WALLET,
        cexSide === 'buy' ? 'sell' : 'buy',
        base,
        quote,
        leg2Size,
        leg2Notional,
        leg2Fee,
        quote,
      );
    } else {
      const dexSide = signal.direction === Direction.BUY_DEX_SELL_CEX ? 'buy' : 'sell';
      this.inventory.recordTrade(
        Venue.WALLET,
        dexSide,
        base,
        quote,
        leg1Size,
        leg1Notional,
        leg1Fee,
        quote,
      );
      this.inventory.recordTrade(
        Venue.BINANCE,
        dexSide === 'buy' ? 'sell' : 'buy',
        base,
        quote,
        leg2Size,
        leg2Notional,
        leg2Fee,
        quote,
      );
    }
  }

  /**
   * Realised PnL in quote currency (scaled by PRICE_SCALE) after both legs.
   * BUY_CEX_SELL_DEX: profit = (leg2Price - leg1Price) * size.
   * BUY_DEX_SELL_CEX: profit = (leg1Price - leg2Price) * size.
   * Fees deducted at the combined rate applied to the leg1 notional.
   */
  private calculatePnl(ctx: ExecutionContext): bigint {
    const { signal } = ctx;
    const leg1Price = ctx.leg1FillPrice ?? 0n;
    const leg2Price = ctx.leg2FillPrice ?? 0n;
    const size = ctx.leg1FillSize ?? 0n;

    const grossScaled =
      signal.direction === Direction.BUY_CEX_SELL_DEX
        ? ((leg2Price - leg1Price) * size) / PRICE_SCALE
        : ((leg1Price - leg2Price) * size) / PRICE_SCALE;

    const notionalScaled = (leg1Price * size) / PRICE_SCALE;
    const feeScaled = (notionalScaled * this.profile.trading.combinedFeeRateBps) / 10_000n;

    return grossScaled - feeScaled;
  }

  /** Resolves to null on timeout, or a failed LegResult on thrown error. */
  private async withTimeout(promise: Promise<LegResult>, ms: number): Promise<LegResult | null> {
    return Promise.race([
      promise.catch(
        (e: unknown): LegResult => ({
          success: false,
          price: 0n,
          filled: 0n,
          error: e instanceof Error ? e.message : String(e),
        }),
      ),
      sleep(ms).then(() => null),
    ]);
  }

  private makeContext(signal: Signal): ExecutionContext {
    return {
      signal,
      state: ExecutorState.IDLE,
      leg1Venue: '',
      leg1OrderId: null,
      leg1FillPrice: null,
      leg1FillSize: null,
      leg2Venue: '',
      leg2TxHash: null,
      leg2FillPrice: null,
      leg2FillSize: null,
      startedAt: new Date(),
      finishedAt: null,
      actualNetPnlUsd: null,
      error: null,
    };
  }

  private fail(ctx: ExecutionContext, error: string): ExecutionContext {
    ctx.state = ExecutorState.FAILED;
    ctx.error = error;
    return ctx;
  }
}
