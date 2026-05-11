/**
 * Internal fixed-point precision used for all prices and quantities across the project.
 * Every monetary value (prices, trade sizes, PnL) is stored as an integer multiplied by 1e8.
 *
 * This is NOT the token's on-chain decimal count — tokens have their own decimals (ETH=18, USDC=6).
 * Conversions between native token units and PRICE_SCALE happen at the boundary:
 *   native → scaled : (nativeAmount * PRICE_SCALE) / 10n ** BigInt(token.decimals)
 *   scaled → native : (scaledAmount * 10n ** BigInt(token.decimals)) / PRICE_SCALE
 *
 * Example: 1 ETH = 1e18 wei (native). Stored here as 1e8 (= 1 * PRICE_SCALE).
 * Example: 1 USDC = 1e6 micro-USDC (native). Stored here as 1e8 (= 1 * PRICE_SCALE).
 */
export const PRICE_SCALE = 10n ** 8n;

/** Number equivalent of PRICE_SCALE for floating-point percentage calculations. */
export const PRICE_SCALE_NUM = Number(PRICE_SCALE);
