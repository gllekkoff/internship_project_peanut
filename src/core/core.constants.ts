/** Fixed-point scale for all prices and quantities across the project: 8 decimal places. */
export const PRICE_SCALE = 10n ** 8n;

/** Number equivalent of PRICE_SCALE for floating-point percentage calculations. */
export const PRICE_SCALE_NUM = Number(PRICE_SCALE);
