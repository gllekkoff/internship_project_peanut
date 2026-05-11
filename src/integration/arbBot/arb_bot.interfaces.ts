import type { RiskLimits } from '@/safety/risk.interfaces';

/** Configuration for the ArbBot event-driven loop. */
export interface BotConfig {
  /** Fixed trade notional in USD, scaled by PRICE_SCALE. Used when min/max are not set. */
  readonly tradeSizeUsd: bigint;
  /** Dynamic sizing lower bound in USD (PRICE_SCALE). When set with tradeSizeMax, the bot sweeps the range and picks the most profitable size. */
  readonly tradeSizeMin?: bigint;
  /** Dynamic sizing upper bound in USD (PRICE_SCALE). */
  readonly tradeSizeMax?: bigint;
  /** Minimum milliseconds between two signals for the same pair. */
  readonly cooldownMs: number;
  /** Minimum spread in bps before a signal is generated. */
  readonly minSpreadBps: number;
  readonly minScore: number;
  /** Minimum expected net PnL to execute a trade, scaled by PRICE_SCALE. Set to 0 for normal use, negative to allow small losses during test runs. */
  readonly minProfit?: bigint;
  readonly simulationMode: boolean;
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
