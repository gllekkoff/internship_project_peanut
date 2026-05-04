import { fmtUsd } from '@/core/core.formatters';
import type { Signal } from '@/strategy/signal.interfaces';
import type { RiskCheckResult } from './risk.interfaces';

export const DEFAULT_MAX_SPREAD_BPS = 500;
export const DEFAULT_MAX_SIGNAL_AGE_S = 5;
/** Maximum fractional deviation from the recent price average before rejecting a signal. */
export const DEFAULT_MAX_PRICE_DEVIATION = 0.05;
export const DEFAULT_PRICE_HISTORY_SIZE = 20;

export interface PreTradeValidatorConfig {
  readonly maxSpreadBps?: number;
  readonly maxSignalAgeS?: number;
  readonly maxPriceDeviation?: number;
  readonly priceHistorySize?: number;
}

/** Sanity checks on signal fields and price feed consistency before any risk check runs. */
export class PreTradeValidator {
  private readonly maxSpreadBps: number;
  private readonly maxSignalAgeS: number;
  private readonly maxPriceDeviation: number;
  private readonly priceHistorySize: number;
  private readonly priceHistory: Map<string, bigint[]> = new Map();

  constructor(config: PreTradeValidatorConfig = {}) {
    this.maxSpreadBps = config.maxSpreadBps ?? DEFAULT_MAX_SPREAD_BPS;
    this.maxSignalAgeS = config.maxSignalAgeS ?? DEFAULT_MAX_SIGNAL_AGE_S;
    this.maxPriceDeviation = config.maxPriceDeviation ?? DEFAULT_MAX_PRICE_DEVIATION;
    this.priceHistorySize = config.priceHistorySize ?? DEFAULT_PRICE_HISTORY_SIZE;
  }

  /** Validates signal fields and checks CEX price against recent feed history. */
  validateSignal(signal: Signal): RiskCheckResult {
    if (signal.cexPrice <= 0n) {
      return { allowed: false, reason: 'Invalid CEX price' };
    }
    if (signal.dexPrice <= 0n) {
      return { allowed: false, reason: 'Invalid DEX price' };
    }
    if (signal.spreadBps > this.maxSpreadBps) {
      return {
        allowed: false,
        reason: `Spread ${signal.spreadBps.toFixed(1)}bps too high — likely bad data`,
      };
    }
    const ageS = (Date.now() - signal.timestamp.getTime()) / 1_000;
    if (ageS > this.maxSignalAgeS) {
      return { allowed: false, reason: `Signal too old: ${ageS.toFixed(1)}s` };
    }
    if (signal.size <= 0n) {
      return { allowed: false, reason: 'Invalid trade size' };
    }

    return this.validatePriceFeed(signal.cexPrice, signal.pair);
  }

  /**
   * Checks whether `price` deviates more than 5% from the recent average for the pair.
   * Records the price in history when it passes so future calls can detect anomalies.
   */
  validatePriceFeed(price: bigint, pair: string): RiskCheckResult {
    const history = this.priceHistory.get(pair) ?? [];

    if (history.length > 0) {
      const avg = history.reduce((sum, p) => sum + p, 0n) / BigInt(history.length);
      if (avg > 0n) {
        const deviation = Math.abs(Number(price - avg)) / Number(avg);
        if (deviation > this.maxPriceDeviation) {
          return {
            allowed: false,
            reason: `Price ${fmtUsd(price)} deviates ${(deviation * 100).toFixed(1)}% from recent avg ${fmtUsd(avg)}`,
          };
        }
      }
    }

    history.push(price);
    if (history.length > this.priceHistorySize) history.shift();
    this.priceHistory.set(pair, history);

    return { allowed: true, reason: 'OK' };
  }
}
