/** Milliseconds to wait for a CEX leg IOC order to fill. */
export const DEFAULT_LEG1_TIMEOUT_MS = 5_000;

/** Milliseconds to wait for a DEX transaction to confirm. */
export const DEFAULT_LEG2_TIMEOUT_MS = 60_000;

/** Minimum fill ratio [0–1] below which a partial CEX fill triggers failure. */
export const DEFAULT_MIN_FILL_RATIO = 0.8;

/** Price buffer applied to CEX limit orders to improve fill probability (0.1%). */
export const CEX_PRICE_BUFFER_BPS = 10n;
