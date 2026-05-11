export const BALANCE_SYNC_INTERVAL_MS = 30_000;

/** Estimated gas units consumed by a single Uniswap V2 swap. */
export const SWAP_GAS_UNITS = 180_000n;
/** How long a fetched gas price stays valid before a fresh RPC call is made. */
export const GAS_PRICE_TTL_MS = 30_000;
/** Fallback gas cost in USD (PRICE_SCALE) when the RPC call fails. */
export const GAS_COST_FALLBACK = 5n * 100_000_000n;
/** Minimum gas cost floor in USD (PRICE_SCALE) — prevents unrealistically cheap gas from skewing PnL. */
export const GAS_COST_MIN = 2n * 100_000_000n;
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
