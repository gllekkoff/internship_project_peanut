/** Canonical identifier for each supported CEX venue. */
export enum VenueId {
  BINANCE = 'binance',
  BYBIT = 'bybit',
}

/** Request weight cost per endpoint — exchange-specific, documented not runtime-discoverable. */
export interface EndpointWeights {
  readonly orderBook: number;
  readonly balance: number;
  readonly createOrder: number;
  readonly cancelOrder: number;
  readonly fetchOrder: number;
  readonly tradingFees: number;
}

/** Rate limiting parameters for a venue's REST API. */
export interface RateLimitConfig {
  /** Maximum weight units consumable per window before throttling. */
  readonly weightLimit: number;
  /** Rolling window duration in milliseconds. */
  readonly windowMs: number;
  readonly weights: EndpointWeights;
}

/** Withdrawal parameters for a single asset. All monetary values scaled by PRICE_SCALE (1e8). */
export interface WithdrawalConfig {
  /** Fee deducted in transit. Mutable so VenueHydrator can overwrite with live API data. */
  withdrawalFee: bigint;
  readonly minWithdrawal: bigint;
  readonly confirmations: number;
  readonly estimatedTimeMin: number;
}

/** Inventory management parameters for a venue. */
export interface InventoryConfig {
  /**
   * Per-asset withdrawal parameters, keyed by asset symbol (e.g. 'ETH').
   * withdrawalFee entries are mutable — VenueHydrator overwrites them at startup.
   */
  readonly withdrawalFees: Record<string, WithdrawalConfig>;
  /** Minimum balance per asset that must remain after any transfer. Scaled by PRICE_SCALE (1e8). */
  readonly minOperatingBalance: Record<string, bigint>;
  /** Rebalance when max deviation from ideal split exceeds this many percentage points. */
  readonly rebalanceThresholdPct: number;
}

/** Trading fee parameters used by the executor for PnL calculation. */
export interface TradingConfig {
  /** Combined fee cost for both legs in basis points (e.g. 40 = 0.40%). Mutable so VenueHydrator can refine from live fee data. */
  combinedFeeRateBps: bigint;
}

/** Complete configuration profile for one CEX venue. */
export interface VenueProfile {
  readonly id: VenueId;
  readonly displayName: string;
  readonly rateLimit: RateLimitConfig;
  readonly inventory: InventoryConfig;
  readonly trading: TradingConfig;
  /** Set to true by VenueHydrator.hydrate() once live API data has been written in. */
  hydrated: boolean;
}
