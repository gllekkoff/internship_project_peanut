import type { CheckResult } from '@/inventory/rebalancer/rebalancer.interfaces';
import type { Signal } from '@/strategy/signal.interfaces';
import type { ScorerConfig } from '@/strategy/scorer/scorer.interfaces';

/** Scores signals 0–100 across spread, liquidity, inventory health, and trade history. */
export class SignalScorer {
  private readonly spreadWeight: number;
  private readonly liquidityWeight: number;
  private readonly inventoryWeight: number;
  private readonly historyWeight: number;
  private readonly excellentSpreadBps: number;
  private readonly minSpreadBps: number;
  /** Rolling window of (pair, success) outcomes; capped at 100 entries. */
  private recentResults: Array<readonly [string, boolean]> = [];

  constructor(config: ScorerConfig = {}) {
    this.spreadWeight = config.spreadWeight ?? 0.4;
    this.liquidityWeight = config.liquidityWeight ?? 0.2;
    this.inventoryWeight = config.inventoryWeight ?? 0.2;
    this.historyWeight = config.historyWeight ?? 0.2;
    this.excellentSpreadBps = config.excellentSpreadBps ?? 100;
    this.minSpreadBps = config.minSpreadBps ?? 30;
  }

  /**
   * Computes a composite 0–100 score for a signal given current inventory skews.
   * Weights must sum to 1.0; liquidity component is a fixed placeholder (80).
   */
  score(signal: Signal, checks: CheckResult[]): number {
    const spread = this.scoreSpread(signal.spreadBps);
    const liquidity = 80; // placeholder — no on-chain depth feed available yet
    const inventory = this.scoreInventory(signal, checks);
    const history = this.scoreHistory(signal.pair);

    const weighted =
      spread * this.spreadWeight +
      liquidity * this.liquidityWeight +
      inventory * this.inventoryWeight +
      history * this.historyWeight;

    return Math.round(Math.max(0, Math.min(100, weighted)) * 10) / 10;
  }

  /** Records the outcome of an executed signal for use in future history scoring. */
  recordResult(pair: string, success: boolean): void {
    this.recentResults.push([pair, success] as const);
    if (this.recentResults.length > 100) {
      this.recentResults = this.recentResults.slice(-100);
    }
  }

  /**
   * Applies a linear time-decay to a score (or signal.score if not provided).
   * Score decays by up to 50% as the signal approaches its expiry.
   */
  applyDecay(signal: Signal, score?: number): number {
    const ageSeconds = signal.ageSeconds();
    const ttlSeconds = (signal.expiry.getTime() - signal.timestamp.getTime()) / 1_000;
    const decayFactor = Math.max(0, 1 - (ageSeconds / ttlSeconds) * 0.5);
    return (score ?? signal.score) * decayFactor;
  }

  /** Linear interpolation between minSpreadBps (→ 0) and excellentSpreadBps (→ 100). */
  private scoreSpread(spreadBps: number): number {
    if (spreadBps <= this.minSpreadBps) return 0;
    if (spreadBps >= this.excellentSpreadBps) return 100;
    return ((spreadBps - this.minSpreadBps) / (this.excellentSpreadBps - this.minSpreadBps)) * 100;
  }

  /**
   * Scores based on InventoryTracker.getSkews() output for the signal's base asset.
   * Returns 20 when rebalancing is needed (elevated risk), 60 otherwise.
   */
  private scoreInventory(signal: Signal, checks: CheckResult[]): number {
    const base = signal.pair.split('/')[0] ?? signal.pair;
    const relevant = checks.filter((c) => c.asset === base);
    if (relevant.some((c) => c.needsRebalance)) return 20;
    return 60;
  }

  /** Win-rate over the last 20 results for this pair; returns 50 when fewer than 3 exist. */
  private scoreHistory(pair: string): number {
    const results = this.recentResults.slice(-20).filter(([p]) => p === pair);
    if (results.length < 3) return 50;
    return (results.filter(([, ok]) => ok).length / results.length) * 100;
  }
}
