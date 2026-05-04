import { PRICE_SCALE } from '@/core/core.constants';
import type { RiskLimits } from './risk.interfaces';

/** Tight risk limits for production — real money, real losses. */
export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxTradeUsd: 20n * PRICE_SCALE,
  maxTradePct: 0.2,
  maxPositionPerToken: 30n * PRICE_SCALE,
  maxOpenPositions: 1,
  maxLossPerTrade: 5n * PRICE_SCALE,
  maxDailyLoss: 15n * PRICE_SCALE,
  maxDrawdownPct: 0.2,
  maxTradesPerHour: 20,
  consecutiveLossLimit: 3,
};

/** Relaxed risk limits for testnet — larger trade sizes to exercise the full pipeline. */
export const TESTNET_RISK_LIMITS: RiskLimits = {
  maxTradeUsd: 1_000n * PRICE_SCALE,
  maxTradePct: 0.2,
  maxPositionPerToken: 30n * PRICE_SCALE,
  maxOpenPositions: 1,
  maxLossPerTrade: 5n * PRICE_SCALE,
  maxDailyLoss: 500n * PRICE_SCALE,
  maxDrawdownPct: 0.2,
  maxTradesPerHour: 20,
  consecutiveLossLimit: 3,
};

/** Returns the appropriate risk limits for the current environment. */
export function getRiskLimits(production: boolean): RiskLimits {
  return production ? DEFAULT_RISK_LIMITS : TESTNET_RISK_LIMITS;
}

/** Milliseconds in one hour — used for the rolling trade-frequency window. */
export const HOUR_MS = 60 * 60 * 1_000;
