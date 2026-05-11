/** Milliseconds to wait for a CEX leg IOC order to fill. */
export const DEFAULT_LEG1_TIMEOUT_MS = 5_000;

/** Milliseconds to wait for a DEX transaction to confirm. */
export const DEFAULT_LEG2_TIMEOUT_MS = 60_000;

/** Minimum fill ratio [0–1] below which a partial CEX fill triggers failure. */
export const DEFAULT_MIN_FILL_RATIO = 0.8;

/** Price buffer applied to CEX limit orders to improve fill probability (0.1%). */
export const CEX_PRICE_BUFFER_BPS = 10n;

/**
 * Maximum slippage accepted on an emergency DEX unwind (5%).
 * Prevents a MEV sandwich from turning a failed trade into an unbounded loss.
 * Deliberately loose — the primary goal is to exit the position, not optimise fill price.
 */
export const UNWIND_SLIPPAGE_BPS = 500n;

/** Fixed gas limit for DEX swaps — avoids estimateGas timing issues when pool state shifts between quote and submission. */
export const DEX_SWAP_GAS_LIMIT = 200_000n;
