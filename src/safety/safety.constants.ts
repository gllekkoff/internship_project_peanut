import { PRICE_SCALE } from '@/core/core.constants';
import { fmtUsd } from '@/core/core.formatters';
import type { RiskCheckResult } from './risk.interfaces';

// DO NOT MODIFY — these are non-negotiable hard ceilings enforced after all configurable checks.
export const ABSOLUTE_MAX_TRADE_USD = 25n * PRICE_SCALE;
export const ABSOLUTE_MAX_DAILY_LOSS = 20n * PRICE_SCALE;
export const ABSOLUTE_MIN_CAPITAL = 40n * PRICE_SCALE;
export const ABSOLUTE_MAX_TRADES_PER_HOUR = 30;

export function absoluteSafetyCheck(
  tradeUsd: bigint,
  dailyLoss: bigint,
  totalCapital: bigint,
  tradesThisHour: number,
): RiskCheckResult {
  if (tradeUsd > ABSOLUTE_MAX_TRADE_USD) {
    return {
      allowed: false,
      reason: `Trade ${fmtUsd(tradeUsd)} exceeds absolute max ${fmtUsd(ABSOLUTE_MAX_TRADE_USD)}`,
    };
  }
  if (dailyLoss <= -ABSOLUTE_MAX_DAILY_LOSS) {
    return { allowed: false, reason: 'Absolute daily loss limit reached' };
  }
  if (totalCapital < ABSOLUTE_MIN_CAPITAL) {
    return {
      allowed: false,
      reason: `Capital ${fmtUsd(totalCapital)} below absolute minimum ${fmtUsd(ABSOLUTE_MIN_CAPITAL)}`,
    };
  }
  if (tradesThisHour >= ABSOLUTE_MAX_TRADES_PER_HOUR) {
    return { allowed: false, reason: 'Absolute hourly trade limit reached' };
  }
  return { allowed: true, reason: 'OK' };
}
