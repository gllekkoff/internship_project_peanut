import type { RiskLimits } from '@/safety/risk.interfaces';

/** Configuration for the ArbBot event-driven loop. */
export interface BotConfig {
  /** Target trade notional in USD, scaled by PRICE_SCALE. Actual size is computed per-tick from the live CEX price. */
  readonly tradeSizeUsd: bigint;
  /** Minimum milliseconds between two signals for the same pair. */
  readonly cooldownMs: number;
  /** Minimum spread in bps before a signal is generated. */
  readonly minSpreadBps: number;
  readonly minScore: number;
  readonly simulationMode: boolean;
  /** When true, bypasses profit buffer and score threshold — logs every spread above minSpreadBps. Only valid in sim/paper mode. */
  readonly demoMode?: boolean;
  /** Override default risk limits. Omit to use DEFAULT_RISK_LIMITS. */
  readonly riskLimits?: RiskLimits;
  /**
   * On-chain address of the base token (e.g. WETH). Must match one of the two tokens in the
   * configured pool. Used to identify token order without relying on symbol heuristics.
   */
  readonly baseTokenAddress: string;
  /** On-chain address of the quote token (e.g. USDC). Must be the other token in the pool. */
  readonly quoteTokenAddress: string;
}
