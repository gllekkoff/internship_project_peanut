/** Configuration for the windowed circuit breaker. All time values in milliseconds. */
export interface CircuitBreakerConfig {
  /** Number of failures within windowMs that trips the breaker (default 3). */
  readonly failureThreshold?: number;
  /** Rolling window size for counting failures (default 300_000 = 5 min). */
  readonly windowMs?: number;
  /** How long the breaker stays open before auto-resetting (default 600_000 = 10 min). */
  readonly cooldownMs?: number;
}

/** Configuration for TTL-based replay protection. */
export interface ReplayProtectionConfig {
  /** Milliseconds a signal ID is retained before it can be re-executed (default 60_000 = 1 min). */
  readonly ttlMs?: number;
}
