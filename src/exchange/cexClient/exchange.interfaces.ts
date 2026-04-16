/** Price level entry: [price, quantity] — both scaled by PRICE_SCALE (1e8). */
export type PriceLevel = [bigint, bigint];

/** Normalised L2 order book snapshot. All prices and quantities scaled by PRICE_SCALE. */
export interface OrderBook {
  readonly symbol: string;
  readonly timestamp: number;
  /** Sorted best (highest) bid first. */
  readonly bids: readonly PriceLevel[];
  /** Sorted best (lowest) ask first. */
  readonly asks: readonly PriceLevel[];
  readonly bestBid: PriceLevel;
  readonly bestAsk: PriceLevel;
  /** (bestBid + bestAsk) / 2, scaled by PRICE_SCALE. */
  readonly midPrice: bigint;
  /** (ask - bid) / mid * 10000 — in basis points, unscaled. */
  readonly spreadBps: bigint;
}

/** Normalised balance for a single asset. All amounts scaled by PRICE_SCALE. */
export interface AssetBalance {
  readonly free: bigint;
  readonly locked: bigint;
  readonly total: bigint;
}

/** Normalised result returned after any order action. All monetary values scaled by PRICE_SCALE. */
export interface OrderResult {
  readonly id: string;
  readonly symbol: string;
  readonly side: string;
  readonly type: string;
  readonly timeInForce: string;
  readonly amountRequested: bigint;
  readonly amountFilled: bigint;
  readonly avgFillPrice: bigint;
  readonly fee: bigint;
  readonly feeAsset: string;
  /** 'filled' | 'partially_filled' | 'expired' | 'canceled' | 'open' */
  readonly status: string;
  readonly timestamp: number;
}

/** Fee rates for a symbol. Scaled by PRICE_SCALE (e.g. 0.001 taker → 100_000n). */
export interface TradingFees {
  readonly maker: bigint;
  readonly taker: bigint;
}

/** Config shape accepted by ExchangeClient — matches config.binance exactly. */
export interface ExchangeConfig {
  readonly apiKey: string | undefined;
  readonly secret: string | undefined;
  readonly sandbox: boolean;
  readonly options: { readonly defaultType: string };
  readonly enableRateLimit: boolean;
}

/** Internal rate limiter entry. */
export interface WeightEntry {
  time: number;
  weight: number;
}
