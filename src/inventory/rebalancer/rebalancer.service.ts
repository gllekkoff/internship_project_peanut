import type { InventoryTracker } from '../tracker/tracker.service';
import { Venue } from '../tracker/tracker.interfaces';
import {
  DEFAULT_THRESHOLD_PCT,
  MIN_OPERATING_BALANCE,
  TRANSFER_FEES,
} from './rebalancer.constants';
import type { CheckResult, EstimateCostResult } from './rebalancer.interfaces';
import { TransferPlan } from './rebalancer.interfaces';

/**
 * Generates transfer plans to rebalance inventory skew across venues.
 * Plans only — does NOT execute transfers.
 */
export class RebalancePlanner {
  private readonly tracker: InventoryTracker;
  private readonly thresholdPct: number;
  private readonly targetRatio: Record<Venue, number>;

  /**
   * @param tracker       Live InventoryTracker instance.
   * @param thresholdPct  Rebalance when max deviation exceeds this percentage (default 30).
   * @param targetRatio   Desired fraction per venue (must sum to 1). Defaults to equal split.
   */
  constructor(
    tracker: InventoryTracker,
    thresholdPct: number = DEFAULT_THRESHOLD_PCT,
    targetRatio?: Partial<Record<Venue, number>>,
  ) {
    this.tracker = tracker;
    this.thresholdPct = thresholdPct;

    const venues = Object.values(Venue);
    const equalShare = 1 / venues.length;
    this.targetRatio = Object.fromEntries(
      venues.map((v) => [v, targetRatio?.[v] ?? equalShare]),
    ) as Record<Venue, number>;
  }

  /**
   * Returns a summary of skew status for every tracked asset.
   * Only maxDeviationPct and needsRebalance are surfaced — no transfer detail.
   */
  checkAll(): CheckResult[] {
    return this.tracker.getSkews().map(({ asset, maxDeviationPct, needsRebalance }) => ({
      asset,
      maxDeviationPct,
      needsRebalance,
    }));
  }

  /**
   * Generates the minimal set of transfers that brings `asset` back to the target ratio.
   * Returns an empty list when skew is within threshold or no valid transfer can be made.
   *
   * Rules applied per candidate transfer:
   * - Amount >= minWithdrawal for the asset
   * - Source venue retains >= MIN_OPERATING_BALANCE after the transfer
   */
  plan(asset: string): TransferPlan[] {
    const skew = this.tracker.skew(asset);
    if (skew.maxDeviationPct < this.thresholdPct) return [];

    const feeInfo = TRANSFER_FEES[asset];
    const minOp = MIN_OPERATING_BALANCE[asset] ?? 0n;

    // Compute target amount per venue and the resulting surplus/deficit.
    const total = skew.total;
    const surpluses: Array<{ venue: Venue; excess: bigint }> = [];
    const deficits: Array<{ venue: Venue; need: bigint }> = [];

    for (const [venueName, venueSkew] of Object.entries(skew.venues)) {
      const venue = venueName as Venue;
      const target = BigInt(Math.round(Number(total) * this.targetRatio[venue]));
      const delta = venueSkew.amount - target;
      if (delta > 0n) surpluses.push({ venue, excess: delta });
      else if (delta < 0n) deficits.push({ venue, need: -delta });
    }

    // Greedy match: pair the largest surplus with the largest deficit.
    surpluses.sort((a, b) => (a.excess > b.excess ? -1 : 1));
    deficits.sort((a, b) => (a.need > b.need ? -1 : 1));

    const plans: TransferPlan[] = [];
    let si = 0;
    let di = 0;

    while (si < surpluses.length && di < deficits.length) {
      const sender = surpluses[si]!;
      const receiver = deficits[di]!;

      // Candidate amount: smallest of what sender can send and what receiver needs.
      let amount = sender.excess < receiver.need ? sender.excess : receiver.need;

      // Enforce minimum withdrawal.
      if (feeInfo && amount < feeInfo.minWithdrawal) {
        si++;
        continue;
      }

      // Enforce minimum operating balance at the source venue.
      const senderBalance = this.tracker.getAvailable(sender.venue, asset);
      const afterTransfer = senderBalance - amount;
      if (afterTransfer < minOp) {
        // Trim amount so the sender keeps MIN_OPERATING_BALANCE.
        amount = senderBalance - minOp;
        if (feeInfo && amount < feeInfo.minWithdrawal) {
          si++;
          continue;
        }
      }

      const fee = feeInfo?.withdrawalFee ?? 0n;
      const timeMin = feeInfo?.estimatedTimeMin ?? 0;
      plans.push(new TransferPlan(sender.venue, receiver.venue, asset, amount, fee, timeMin));

      // Consume the matched portions.
      sender.excess -= amount;
      receiver.need -= amount;
      if (sender.excess <= 0n) si++;
      if (receiver.need <= 0n) di++;
    }

    return plans;
  }

  /** Runs plan() for every tracked asset and collects results. */
  planAll(): Record<string, TransferPlan[]> {
    const result: Record<string, TransferPlan[]> = {};
    for (const { asset } of this.tracker.getSkews()) {
      const plans = this.plan(asset);
      if (plans.length > 0) result[asset] = plans;
    }
    return result;
  }

  /**
   * Aggregate cost estimate across a list of plans.
   * totalTimeMin is the wall-clock duration assuming all transfers run in parallel.
   * totalFeesUsd is null — no price feed is wired in.
   */
  estimateCost(plans: TransferPlan[]): EstimateCostResult {
    const assetsAffected = [...new Set(plans.map((p) => p.asset))];
    const totalTimeMin = plans.reduce((max, p) => Math.max(max, p.estimatedTimeMin), 0);

    return {
      totalTransfers: plans.length,
      totalFeesUsd: null,
      totalTimeMin,
      assetsAffected,
    };
  }
}
