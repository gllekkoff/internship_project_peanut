/** Hard limits enforced by RiskManager before every trade. All monetary values scaled by PRICE_SCALE. */
export interface RiskLimits {
  /** Maximum trade notional value in quote currency. */
  readonly maxTradeUsd: bigint;
  /** Maximum trade size as a fraction of current capital [0–1]. */
  readonly maxTradePct: number;
  /** Maximum value of any single token position. Enforced externally via inventory. */
  readonly maxPositionPerToken: bigint;
  /** Maximum number of concurrent open trades. Enforced externally via execution flow. */
  readonly maxOpenPositions: number;
  /** Maximum loss on a single trade before the bot stops. */
  readonly maxLossPerTrade: bigint;
  /** Maximum cumulative daily loss before trading halts until resetDaily() is called. */
  readonly maxDailyLoss: bigint;
  /** Maximum drawdown from peak capital as a fraction [0–1] before trading halts. */
  readonly maxDrawdownPct: number;
  /** Maximum number of trades allowed in a rolling 1-hour window. */
  readonly maxTradesPerHour: number;
  /** Maximum consecutive losing trades before trading halts until resetDaily() is called. */
  readonly consecutiveLossLimit: number;
}

/** Result of a pre-trade risk check. */
export interface RiskCheckResult {
  readonly allowed: boolean;
  readonly reason: string;
}
