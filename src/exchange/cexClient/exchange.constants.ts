/** Fixed-point scale for all exchange prices and quantities: 8 decimal places. */
export const PRICE_SCALE = 10n ** 8n;

/** Binance allows 1200 weight/min; throttle at 1100 to keep a safety buffer. */
export const WEIGHT_LIMIT = 1100;

/** Sliding window duration for request weight tracking. */
export const WEIGHT_WINDOW_MS = 60_000;

/** Approximate Binance request weights per endpoint. */
export const WEIGHTS = {
  orderBook: 1,
  balance: 10,
  createOrder: 1,
  cancelOrder: 1,
  fetchOrder: 2,
  tradingFees: 1,
} as const;
