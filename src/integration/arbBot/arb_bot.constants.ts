export const BALANCE_SYNC_INTERVAL_MS = 30_000;
export const DAILY_RESET_INTERVAL_MS = 60 * 60 * 1_000; // check every hour, reset triggers on UTC date change
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Allowed balance divergence for the base asset (e.g. ETH), in PRICE_SCALE units.
 * 0.001 base units ≈ $3 at $3 000/ETH — covers rounding on small fills.
 */
export const BASE_MISMATCH_THRESHOLD = 100_000n;

/**
 * Allowed balance divergence for the quote asset (e.g. USDC), in PRICE_SCALE units.
 * 1n * PRICE_SCALE = $1 — covers CEX fee rounding and minor slippage on a $18 trade.
 */
export const QUOTE_MISMATCH_THRESHOLD = 1_00_000_000n; // 1 USD × PRICE_SCALE
