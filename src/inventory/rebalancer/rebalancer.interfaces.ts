import type { Venue } from '../tracker/tracker.interfaces';

/** A planned asset transfer between two venues. `amount` is what is sent; `netAmount` is what arrives. */
export class TransferPlan {
  constructor(
    readonly fromVenue: Venue,
    readonly toVenue: Venue,
    readonly asset: string,
    /** Amount sent from the source venue, scaled by PRICE_SCALE. */
    readonly amount: bigint,
    /** Withdrawal / gas fee deducted in transit, scaled by PRICE_SCALE. */
    readonly estimatedFee: bigint,
    /** Estimated minutes until the transfer settles. */
    readonly estimatedTimeMin: number,
  ) {}

  /** Amount that arrives at the destination after fees: amount − estimatedFee. */
  get netAmount(): bigint {
    return this.amount - this.estimatedFee;
  }
}

/** Per-asset skew summary returned by checkAll(). */
export interface CheckResult {
  readonly asset: string;
  readonly maxDeviationPct: number;
  readonly needsRebalance: boolean;
}

/** Fee and timing parameters for one asset's transfer. All monetary values scaled by PRICE_SCALE. */
export interface TransferFeeInfo {
  readonly withdrawalFee: bigint;
  readonly minWithdrawal: bigint;
  readonly confirmations: number;
  readonly estimatedTimeMin: number;
}

/** Aggregate cost estimate across a set of TransferPlans. */
export interface EstimateCostResult {
  readonly totalTransfers: number;
  /** null when no price feed is available to convert fees to USD. */
  readonly totalFeesUsd: bigint | null;
  /** Wall-clock time assuming all transfers run in parallel. */
  readonly totalTimeMin: number;
  readonly assetsAffected: string[];
}
