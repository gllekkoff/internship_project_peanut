/** Number of failures within the window that trips the circuit breaker. */
export const DEFAULT_FAILURE_THRESHOLD = 3;

/** Rolling window over which failures are counted (5 minutes). */
export const DEFAULT_WINDOW_MS = 300_000;

/** How long the breaker stays open before auto-resetting (10 minutes). */
export const DEFAULT_COOLDOWN_MS = 600_000;

/** How long a signal ID is remembered before it can be re-executed (1 minute). */
export const DEFAULT_REPLAY_TTL_MS = 60_000;
