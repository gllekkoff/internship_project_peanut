import { PRICE_SCALE, PRICE_SCALE_NUM } from '@/core/core.constants';
import { fmtUsd } from '@/core/core.formatters';
import type { Signal } from '@/strategy/signal.interfaces';
import { DEFAULT_RISK_LIMITS, HOUR_MS } from './risk.constants';
import type { RiskCheckResult, RiskLimits } from './risk.interfaces';

export class RiskManager {
  private readonly limits: RiskLimits;
  private peakCapital: bigint;
  private currentCapital: bigint;
  private dailyPnl: bigint = 0n;
  private consecutiveLosses: number = 0;
  /** Timestamps (ms) of trades within the rolling 1-hour window. */
  private readonly tradeTimestamps: number[] = [];

  constructor(limits: RiskLimits = DEFAULT_RISK_LIMITS, initialCapital: bigint) {
    this.limits = limits;
    this.peakCapital = initialCapital;
    this.currentCapital = initialCapital;
  }

  checkPreTrade(signal: Signal): RiskCheckResult {
    const tradeValue = (signal.size * signal.cexPrice) / PRICE_SCALE;

    if (tradeValue > this.limits.maxTradeUsd) {
      return {
        allowed: false,
        reason: `Trade ${fmtUsd(tradeValue)} exceeds max ${fmtUsd(this.limits.maxTradeUsd)}`,
      };
    }

    const maxByPct = BigInt(Math.floor(Number(this.currentCapital) * this.limits.maxTradePct));
    if (tradeValue > maxByPct) {
      return {
        allowed: false,
        reason: `Trade exceeds ${(this.limits.maxTradePct * 100).toFixed(0)}% of capital`,
      };
    }

    if (signal.expectedNetPnl < 0n && -signal.expectedNetPnl > this.limits.maxLossPerTrade) {
      return {
        allowed: false,
        reason: `Expected loss ${fmtUsd(-signal.expectedNetPnl)} exceeds per-trade limit ${fmtUsd(this.limits.maxLossPerTrade)}`,
      };
    }

    if (this.dailyPnl <= -this.limits.maxDailyLoss) {
      return {
        allowed: false,
        reason: `Daily loss limit reached: -${fmtUsd(-this.dailyPnl)}`,
      };
    }

    if (this.peakCapital > 0n) {
      const drawdownBps = ((this.peakCapital - this.currentCapital) * 10_000n) / this.peakCapital;
      const limitBps = BigInt(Math.round(this.limits.maxDrawdownPct * 10_000));
      if (drawdownBps >= limitBps) {
        return {
          allowed: false,
          reason: `Drawdown ${(Number(drawdownBps) / 100).toFixed(1)}% exceeds limit`,
        };
      }
    }

    if (this.consecutiveLosses >= this.limits.consecutiveLossLimit) {
      return {
        allowed: false,
        reason: `Consecutive loss limit (${this.consecutiveLosses}) reached`,
      };
    }

    this.pruneTradeWindow();
    if (this.tradeTimestamps.length >= this.limits.maxTradesPerHour) {
      return { allowed: false, reason: 'Hourly trade limit reached' };
    }

    return { allowed: true, reason: 'OK' };
  }

  recordTrade(pnl: bigint): void {
    this.dailyPnl += pnl;
    this.currentCapital += pnl;
    if (this.currentCapital > this.peakCapital) {
      this.peakCapital = this.currentCapital;
    }
    this.tradeTimestamps.push(Date.now());

    if (pnl < 0n) {
      this.consecutiveLosses++;
    } else {
      this.consecutiveLosses = 0;
    }
  }

  resetDaily(): void {
    this.dailyPnl = 0n;
    this.consecutiveLosses = 0;
  }

  /** Re-seeds both current and peak capital — called once after actual wallet balances are known at startup. */
  setInitialCapital(capital: bigint): void {
    this.currentCapital = capital;
    this.peakCapital = capital;
  }

  status(): {
    dailyPnlUsd: number;
    currentCapitalUsd: number;
    drawdownPct: number;
    consecutiveLosses: number;
    tradesThisHour: number;
  } {
    this.pruneTradeWindow();
    const drawdownPct =
      this.peakCapital > 0n
        ? Number((this.peakCapital - this.currentCapital) * 10_000n) /
          Number(this.peakCapital) /
          100
        : 0;
    return {
      dailyPnlUsd: Number(this.dailyPnl) / PRICE_SCALE_NUM,
      currentCapitalUsd: Number(this.currentCapital) / PRICE_SCALE_NUM,
      drawdownPct,
      consecutiveLosses: this.consecutiveLosses,
      tradesThisHour: this.tradeTimestamps.length,
    };
  }

  private pruneTradeWindow(): void {
    const cutoff = Date.now() - HOUR_MS;
    let i = 0;
    while (i < this.tradeTimestamps.length && this.tradeTimestamps[i]! <= cutoff) {
      i++;
    }
    if (i > 0) this.tradeTimestamps.splice(0, i);
  }
}
