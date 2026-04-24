export interface ScorerConfig {
  readonly spreadWeight?: number;
  readonly liquidityWeight?: number;
  readonly inventoryWeight?: number;
  readonly historyWeight?: number;
  /** Spread at or above this value scores 100 on the spread component (bps). */
  readonly excellentSpreadBps?: number;
  /** Spread at or below this value scores 0 on the spread component (bps). */
  readonly minSpreadBps?: number;
}
