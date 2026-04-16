/** Trading venue — CEX or on-chain wallet. */
export enum Venue {
  BINANCE = 'binance',
  WALLET = 'wallet',
}

/** Balance for a single asset at a single venue. All amounts scaled by PRICE_SCALE. */
export interface Balance {
  readonly venue: Venue;
  readonly asset: string;
  readonly free: bigint;
  readonly locked: bigint;
}

/** Per-asset, per-venue breakdown inside a snapshot. */
export interface VenueAssetSnapshot {
  readonly free: bigint;
  readonly locked: bigint;
  readonly total: bigint;
}

/** Full portfolio snapshot across all venues. */
export interface Snapshot {
  readonly timestamp: Date;
  /** venues[venueName][asset] = VenueAssetSnapshot */
  readonly venues: Record<string, Record<string, VenueAssetSnapshot>>;
  /** Cross-venue totals per asset. */
  readonly totals: Record<string, bigint>;
  /** Total portfolio value in USD, null when no price feed is available. */
  readonly totalUsd: bigint | null;
}

/** Per-venue breakdown inside a skew result. pct and deviationPct are percentage points (0–100). */
export interface VenueSkew {
  readonly amount: bigint;
  /** Percentage of total held at this venue: (amount / total) * 100. */
  readonly pct: number;
  /** Distance from the ideal even split: pct - (100 / numVenues). */
  readonly deviationPct: number;
}

/** Distribution skew for one asset across all venues. */
export interface SkewResult {
  readonly asset: string;
  readonly total: bigint;
  readonly venues: Record<string, VenueSkew>;
  /** Largest absolute deviation from the ideal split, in percentage points. */
  readonly maxDeviationPct: number;
  /** True when maxDeviationPct exceeds the rebalance threshold. */
  readonly needsRebalance: boolean;
}

/** Pre-flight check result for a two-legged arbitrage execution. */
export interface CanExecuteResult {
  readonly canExecute: boolean;
  readonly buyVenueAvailable: bigint;
  readonly buyVenueNeeded: bigint;
  readonly sellVenueAvailable: bigint;
  readonly sellVenueNeeded: bigint;
  /** Human-readable reason when canExecute is false; null otherwise. */
  readonly reason: string | null;
}
