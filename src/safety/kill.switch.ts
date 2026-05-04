import { existsSync, writeFileSync } from 'fs';
import { fmtUsd } from '@/core/core.formatters';

const KILL_SWITCH_FILE = '/tmp/arb_bot_kill';
export const HEARTBEAT_FILE = '/tmp/arb_bot_heartbeat';

const KILL_SWITCH_CACHE_MS = 1_000;
let killSwitchCache: { active: boolean; checkedAt: number } = { active: false, checkedAt: 0 };

/** Resets the in-process cache — call only in tests to isolate state between test cases. */
export function _resetKillSwitchCacheForTesting(): void {
  killSwitchCache = { active: false, checkedAt: 0 };
}

export const ERROR_WINDOW_MS = 60 * 60 * 1_000;
export const MAX_ERRORS_PER_HOUR = 50;
/** Stop trading when capital drops below this fraction of initial capital. */
export const CAPITAL_FLOOR_PCT = 0.5;

/**
 * Returns true when the kill switch file exists. Result is cached for 1 second
 * to avoid a filesystem stat on every WebSocket depth message.
 * To stop the bot:   touch /tmp/arb_bot_kill
 * To allow restart:  rm /tmp/arb_bot_kill
 */
export function isKillSwitchActive(): boolean {
  const now = Date.now();
  if (now - killSwitchCache.checkedAt >= KILL_SWITCH_CACHE_MS) {
    killSwitchCache = { active: existsSync(KILL_SWITCH_FILE), checkedAt: now };
  }
  return killSwitchCache.active;
}

/** Writes the current epoch timestamp (ms) to the heartbeat file. */
export function writeHeartbeat(): void {
  writeFileSync(HEARTBEAT_FILE, String(Date.now()));
}

/** Triggers automatically when capital or error-rate thresholds are breached. */
export class AutoKillSwitch {
  private triggered = false;
  private triggerReason: string | null = null;
  private readonly errorTimestamps: number[] = [];

  /** Records one error occurrence; used for the hourly error-rate check. */
  recordError(): void {
    this.errorTimestamps.push(Date.now());
  }

  /**
   * Returns true and logs a reason when a hard condition is breached.
   * Once triggered, always returns true regardless of subsequent state.
   */
  check(currentCapital: bigint, initialCapital: bigint): boolean {
    if (this.triggered) return true;

    if (
      initialCapital > 0n &&
      currentCapital < (initialCapital * BigInt(Math.round(CAPITAL_FLOOR_PCT * 1_000))) / 1_000n
    ) {
      this.trigger(
        `Capital ${fmtUsd(currentCapital)} dropped below ${CAPITAL_FLOOR_PCT * 100}% of initial ${fmtUsd(initialCapital)}`,
      );
      return true;
    }

    this.pruneErrorWindow();
    if (this.errorTimestamps.length > MAX_ERRORS_PER_HOUR) {
      this.trigger(`Error storm: ${this.errorTimestamps.length} errors in the last hour`);
      return true;
    }

    return false;
  }

  get isTriggered(): boolean {
    return this.triggered;
  }

  get reason(): string | null {
    return this.triggerReason;
  }

  private trigger(reason: string): void {
    this.triggered = true;
    this.triggerReason = reason;
  }

  private pruneErrorWindow(): void {
    const cutoff = Date.now() - ERROR_WINDOW_MS;
    let i = 0;
    while (i < this.errorTimestamps.length && this.errorTimestamps[i]! <= cutoff) i++;
    if (i > 0) this.errorTimestamps.splice(0, i);
  }
}
