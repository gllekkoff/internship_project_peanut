import { randomUUID } from 'crypto';
import { PRICE_SCALE_NUM } from '@/core/core.constants';
import type { ArbCheckResult } from '@/integration/arbChecker/arbChecker.interfaces';
import { Direction, Signal } from '@/strategy/signal.interfaces';

/** Default signal lifetime — arb opportunities stale fast. */
const DEFAULT_TTL_MS = 5_000;

/**
 * Converts ArbCheckResult snapshots into scored, expiring Signal objects.
 * Does not execute trades — signal creation and validation only.
 */
export class SignalService {
  private readonly ttlMs: number;

  /** @param ttlMs Milliseconds before a signal expires (default 5s). */
  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /**
   * Builds a Signal from an arb check result, or returns null if the result is not executable.
   * Score is net PnL in bps discounted by DEX price impact — higher impact lowers conviction.
   */
  create(result: ArbCheckResult): Signal | null {
    if (!result.executable || result.direction === null) return null;

    const direction =
      result.direction === 'buy_dex_sell_cex'
        ? Direction.BUY_DEX_SELL_CEX
        : Direction.BUY_CEX_SELL_DEX;

    const cexPrice = direction === Direction.BUY_DEX_SELL_CEX ? result.cexBid : result.cexAsk;

    // quoteNeeded is the trade notional in quote currency, already scaled by PRICE_SCALE.
    const quoteNeeded = result.inventoryDetails.quoteNeeded;

    // PnL values in scaled bigint units — bps values from ArbCheckResult are floats so round them.
    const grossPnl = (BigInt(Math.round(result.gapBps)) * quoteNeeded) / 10_000n;
    // gasCostUsd is a float from chain gas estimation — convert at this boundary.
    const gasCostScaled = BigInt(Math.round(result.details.gasCostUsd * PRICE_SCALE_NUM));
    const totalFees =
      (BigInt(Math.round(result.details.totalCostBps)) * quoteNeeded) / 10_000n + gasCostScaled;
    const netPnl = (BigInt(Math.round(result.estimatedNetPnlBps)) * quoteNeeded) / 10_000n;

    // Score stays float: dimensionless ratio, not a monetary value.
    const impactPenalty = 1 + result.details.dexPriceImpactBps / 10_000;
    const score = result.estimatedNetPnlBps / impactPenalty;

    const pairSlug = result.pair.replace('/', '');
    const signalId = `${pairSlug}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;

    const now = new Date();

    return new Signal({
      signalId,
      pair: result.pair,
      direction,
      cexPrice,
      dexPrice: result.dexPrice,
      spreadBps: result.gapBps,
      size: result.inventoryDetails.baseNeeded,
      expectedGrossPnl: grossPnl,
      expectedFees: totalFees,
      expectedNetPnl: netPnl,
      score,
      timestamp: now,
      expiry: new Date(now.getTime() + this.ttlMs),
      inventoryOk: result.inventoryOk,
      withinLimits: true,
    });
  }

  /** Converts all executable results, dropping nulls. */
  createAll(results: ArbCheckResult[]): Signal[] {
    return results.flatMap((r) => {
      const s = this.create(r);
      return s !== null ? [s] : [];
    });
  }
}
