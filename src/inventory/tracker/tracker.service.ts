import type { AssetBalance } from '@/exchange/cexClient/exchange.interfaces';
import type {
  Balance,
  CanExecuteResult,
  SkewResult,
  Snapshot,
  VenueAssetSnapshot,
  VenueSkew,
} from './tracker.interfaces';
import { Venue } from './tracker.interfaces';

/**
 * Single source of truth for asset positions across CEX and on-chain venues.
 * Balances are replaced on each update — the tracker holds the latest snapshot per venue.
 */
export class InventoryTracker {
  /** venue → asset → Balance */
  private readonly balances: Map<Venue, Map<string, Balance>>;

  /** Initialises balance maps for every venue that will be tracked. */
  constructor(venues: Venue[]) {
    this.balances = new Map(venues.map((v) => [v, new Map()]));
  }

  /**
   * Replaces the stored balances for a CEX venue from an ExchangeClient.fetchBalance() result.
   * Previous snapshot for this venue is discarded entirely.
   */
  updateFromCex(venue: Venue, balances: Record<string, AssetBalance>): void {
    const map = this.requireVenueMap(venue);
    map.clear();
    for (const [asset, bal] of Object.entries(balances)) {
      map.set(asset, { venue, asset, free: bal.free, locked: bal.locked });
    }
  }

  /**
   * Replaces the stored balances for a wallet venue from on-chain data.
   * Amounts must be pre-normalised to PRICE_SCALE by the caller.
   * On-chain wallets have no locked amounts — everything is free.
   */
  updateFromWallet(venue: Venue, balances: Record<string, bigint>): void {
    const map = this.requireVenueMap(venue);
    map.clear();
    for (const [asset, amount] of Object.entries(balances)) {
      if (amount === 0n) continue;
      map.set(asset, { venue, asset, free: amount, locked: 0n });
    }
  }

  /** Returns a full portfolio snapshot across all tracked venues at the current time. */
  snapshot(): Snapshot {
    const venues: Record<string, Record<string, VenueAssetSnapshot>> = {};
    const totals: Record<string, bigint> = {};

    for (const [venue, assetMap] of this.balances) {
      const venueSnapshot: Record<string, VenueAssetSnapshot> = {};
      for (const [asset, bal] of assetMap) {
        const total = bal.free + bal.locked;
        venueSnapshot[asset] = { free: bal.free, locked: bal.locked, total };
        totals[asset] = (totals[asset] ?? 0n) + total;
      }
      venues[venue] = venueSnapshot;
    }

    return { timestamp: new Date(), venues, totals, totalUsd: null };
  }

  /** Returns the free (non-locked) balance of `asset` at `venue`. Zero if unknown. */
  getAvailable(venue: Venue, asset: string): bigint {
    return this.balances.get(venue)?.get(asset)?.free ?? 0n;
  }

  /**
   * Pre-flight check for both legs of an arbitrage:
   * - buy leg: do we have enough `buyAsset` free at `buyVenue`?
   * - sell leg: do we have enough `sellAsset` free at `sellVenue`?
   */
  canExecute(
    buyVenue: Venue,
    buyAsset: string,
    buyAmount: bigint,
    sellVenue: Venue,
    sellAsset: string,
    sellAmount: bigint,
  ): CanExecuteResult {
    const buyAvailable = this.getAvailable(buyVenue, buyAsset);
    const sellAvailable = this.getAvailable(sellVenue, sellAsset);

    const buyOk = buyAvailable >= buyAmount;
    const sellOk = sellAvailable >= sellAmount;

    let reason: string | null = null;
    if (!buyOk && !sellOk) {
      reason = `Insufficient ${buyAsset} at ${buyVenue} and ${sellAsset} at ${sellVenue}`;
    } else if (!buyOk) {
      reason = `Insufficient ${buyAsset} at ${buyVenue}: need ${buyAmount}, have ${buyAvailable}`;
    } else if (!sellOk) {
      reason = `Insufficient ${sellAsset} at ${sellVenue}: need ${sellAmount}, have ${sellAvailable}`;
    }

    return {
      canExecute: buyOk && sellOk,
      buyVenueAvailable: buyAvailable,
      buyVenueNeeded: buyAmount,
      sellVenueAvailable: sellAvailable,
      sellVenueNeeded: sellAmount,
      reason,
    };
  }

  /**
   * Applies a completed trade to the internal balances at `venue`.
   * buy:  base increases, quote decreases, fee deducted from feeAsset.
   * sell: base decreases, quote increases, fee deducted from feeAsset.
   */
  recordTrade(
    venue: Venue,
    side: 'buy' | 'sell',
    baseAsset: string,
    quoteAsset: string,
    baseAmount: bigint,
    quoteAmount: bigint,
    fee: bigint,
    feeAsset: string,
  ): void {
    const map = this.requireVenueMap(venue);

    if (side === 'buy') {
      this.adjustFree(map, venue, baseAsset, baseAmount);
      this.adjustFree(map, venue, quoteAsset, -quoteAmount);
    } else {
      this.adjustFree(map, venue, baseAsset, -baseAmount);
      this.adjustFree(map, venue, quoteAsset, quoteAmount);
    }
    this.adjustFree(map, venue, feeAsset, -fee);
  }

  /**
   * Calculates how an asset's holdings are distributed across venues.
   * Returns deviation from the ideal even split and whether rebalancing is needed.
   */
  skew(asset: string): SkewResult {
    const venueAmounts: Array<[Venue, bigint]> = [];

    for (const [venue, assetMap] of this.balances) {
      const bal = assetMap.get(asset);
      const total = bal ? bal.free + bal.locked : 0n;
      venueAmounts.push([venue, total]);
    }

    const total = venueAmounts.reduce((sum, [, amt]) => sum + amt, 0n);
    const numVenues = venueAmounts.length;
    const idealPct = numVenues > 0 ? 100 / numVenues : 0;

    const venues: Record<string, VenueSkew> = {};
    let maxDeviationPct = 0;

    for (const [venue, amount] of venueAmounts) {
      const pct = total > 0n ? (Number(amount) / Number(total)) * 100 : 0;
      const deviationPct = pct - idealPct;
      const absDeviation = Math.abs(deviationPct);
      if (absDeviation > maxDeviationPct) maxDeviationPct = absDeviation;
      venues[venue] = { amount, pct, deviationPct };
    }

    return { asset, total, venues, maxDeviationPct };
  }

  /**
   * Returns skew results for every asset that appears across any tracked venue.
   * Used by SignalScorer to verify portfolio health before ranking signals.
   */
  getSkews(): SkewResult[] {
    const allAssets = new Set<string>();
    for (const assetMap of this.balances.values()) {
      for (const asset of assetMap.keys()) allAssets.add(asset);
    }
    return [...allAssets].map((asset) => this.skew(asset));
  }

  /** Returns the asset map for a venue, throwing if the venue was not registered at construction. */
  private requireVenueMap(venue: Venue): Map<string, Balance> {
    const map = this.balances.get(venue);
    if (!map)
      throw new Error(`Venue '${venue}' was not registered in InventoryTracker constructor`);
    return map;
  }

  /** Adds `delta` to the free balance of `asset` at `venue`, creating the entry if absent. */
  private adjustFree(map: Map<string, Balance>, venue: Venue, asset: string, delta: bigint): void {
    const existing = map.get(asset);
    const current = existing ?? { venue, asset, free: 0n, locked: 0n };
    map.set(asset, { ...current, free: current.free + delta });
  }
}
