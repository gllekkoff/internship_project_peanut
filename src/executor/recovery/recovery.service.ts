import type { Signal } from '@/strategy/signal.interfaces';
import type { CircuitBreakerConfig, ReplayProtectionConfig } from './recovery.interfaces';
import {
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_WINDOW_MS,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_REPLAY_TTL_MS,
} from './recovery.constants';

/**
 * Windowed circuit breaker: trips when failureThreshold failures occur within windowMs.
 * Auto-resets after cooldownMs — no manual intervention required.
 */
export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;
  /** Timestamps (ms) of failures still within the rolling window. */
  private failures: number[] = [];
  private trippedAt: number | null = null;

  constructor(config: CircuitBreakerConfig = {}) {
    this.failureThreshold = config.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.windowMs = config.windowMs ?? DEFAULT_WINDOW_MS;
    this.cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  }

  /**
   * Records a failure timestamp, prunes the window, and trips the breaker
   * when the in-window failure count reaches the threshold.
   */
  recordFailure(): void {
    const now = Date.now();
    this.failures.push(now);
    this.pruneWindow(now);
    if (this.failures.length >= this.failureThreshold) {
      this.trip();
    }
  }

  /** No-op — reserved for strategies that reset on success. */
  recordSuccess(): void {}

  /**
   * Returns true when the breaker is open (executor must not proceed).
   * Auto-resets to closed once cooldownMs has elapsed since tripping.
   */
  isOpen(): boolean {
    if (this.trippedAt === null) return false;
    if (Date.now() - this.trippedAt > this.cooldownMs) {
      this.reset();
      return false;
    }
    return true;
  }

  /** Milliseconds remaining until the breaker auto-resets; 0 when closed. */
  timeUntilResetMs(): number {
    if (this.trippedAt === null) return 0;
    return Math.max(0, this.cooldownMs - (Date.now() - this.trippedAt));
  }

  private trip(): void {
    this.trippedAt = Date.now();
    console.error('[CircuitBreaker] TRIPPED — executor blocked until cooldown expires');
  }

  private reset(): void {
    this.trippedAt = null;
    this.failures = [];
  }

  private pruneWindow(now: number): void {
    const cutoff = now - this.windowMs;
    this.failures = this.failures.filter((t) => t > cutoff);
  }
}

/**
 * TTL-based replay protection: remembers executed signal IDs for ttlMs,
 * then forgets them so the same pair can trade again after the window expires.
 */
export class ReplayProtection {
  private readonly ttlMs: number;
  /** signalId → execution timestamp (ms). */
  private readonly executed = new Map<string, number>();

  constructor(config: ReplayProtectionConfig = {}) {
    this.ttlMs = config.ttlMs ?? DEFAULT_REPLAY_TTL_MS;
  }

  /** Returns true when this signal ID was executed within the TTL window. */
  isDuplicate(signal: Signal): boolean {
    this.cleanup();
    return this.executed.has(signal.signalId);
  }

  /** Records a signal as executed at the current time. */
  markExecuted(signal: Signal): void {
    this.executed.set(signal.signalId, Date.now());
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, ts] of this.executed) {
      if (ts <= cutoff) this.executed.delete(id);
    }
  }
}
