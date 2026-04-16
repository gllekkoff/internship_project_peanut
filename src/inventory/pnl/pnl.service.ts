import { createWriteStream } from 'node:fs';
import { PRICE_SCALE } from '@/exchange/cexClient/exchange.constants';
import type { PnlSummary, TradeSummary } from './pnl.interfaces';
import { ArbRecord } from './pnl.interfaces';

/** Tracks completed arbitrage trades and produces PnL reports and CSV exports. */
export class PnLEngine {
  private readonly trades: ArbRecord[] = [];

  /** Appends a completed arb trade to the internal ledger. */
  record(trade: ArbRecord): void {
    this.trades.push(trade);
  }

  /** Computes aggregate PnL statistics across all recorded trades. */
  summary(): PnlSummary {
    if (this.trades.length === 0) {
      return {
        totalTrades: 0,
        totalPnlUsd: 0n,
        totalFeesUsd: 0n,
        avgPnlPerTrade: 0n,
        avgPnlBps: 0n,
        winRate: 0,
        bestTradePnl: 0n,
        worstTradePnl: 0n,
        totalNotional: 0n,
        sharpeEstimate: NaN,
        pnlByHour: {},
      };
    }

    const pnls = this.trades.map((t) => t.netPnl);
    const totalPnlUsd = pnls.reduce((s, p) => s + p, 0n);
    const totalFeesUsd = this.trades.reduce((s, t) => s + t.totalFees, 0n);
    const totalNotional = this.trades.reduce((s, t) => s + t.notional, 0n);
    const avgPnlPerTrade = totalPnlUsd / BigInt(this.trades.length);
    const avgPnlBps = totalNotional > 0n ? (totalPnlUsd * 10_000n) / totalNotional : 0n;
    const winRate = pnls.filter((p) => p > 0n).length / pnls.length;
    const bestTradePnl = pnls.reduce((m, p) => (p > m ? p : m), pnls[0]!);
    const worstTradePnl = pnls.reduce((m, p) => (p < m ? p : m), pnls[0]!);

    // Sharpe estimate: mean / stddev using float arithmetic (dimensionless ratio, no bigint needed).
    const floatPnls = pnls.map((p) => Number(p) / Number(PRICE_SCALE));
    const mean = floatPnls.reduce((s, p) => s + p, 0) / floatPnls.length;
    const variance = floatPnls.reduce((s, p) => s + (p - mean) ** 2, 0) / floatPnls.length;
    const sharpeEstimate = variance > 0 ? mean / Math.sqrt(variance) : NaN;

    // Group net PnL by UTC hour.
    const pnlByHour: Record<string, bigint> = {};
    for (const trade of this.trades) {
      const hour = String(trade.timestamp.getUTCHours());
      pnlByHour[hour] = (pnlByHour[hour] ?? 0n) + trade.netPnl;
    }

    return {
      totalTrades: this.trades.length,
      totalPnlUsd,
      totalFeesUsd,
      avgPnlPerTrade,
      avgPnlBps,
      winRate,
      bestTradePnl,
      worstTradePnl,
      totalNotional,
      sharpeEstimate,
      pnlByHour,
    };
  }

  /** Returns the last `n` trades as compact summaries for CLI display. */
  recent(n: number = 10): TradeSummary[] {
    return this.trades
      .slice(-n)
      .reverse()
      .map((t) => ({
        id: t.id,
        timestamp: t.timestamp,
        symbol: t.buyLeg.symbol,
        netPnl: t.netPnl,
        netPnlBps: t.netPnlBps,
        notional: t.notional,
        buyVenue: t.buyLeg.venue,
        sellVenue: t.sellLeg.venue,
      }));
  }

  /**
   * Exports all trades to a CSV file at `filepath`.
   * Each row corresponds to one ArbRecord; both legs are flattened into columns.
   */
  exportCsv(filepath: string): void {
    const stream = createWriteStream(filepath);

    const headers = [
      'id',
      'timestamp',
      'buy_venue',
      'buy_symbol',
      'buy_amount',
      'buy_price',
      'buy_fee',
      'buy_fee_asset',
      'sell_venue',
      'sell_symbol',
      'sell_amount',
      'sell_price',
      'sell_fee',
      'sell_fee_asset',
      'gas_cost_usd',
      'gross_pnl',
      'total_fees',
      'net_pnl',
      'net_pnl_bps',
      'notional',
    ];
    stream.write(headers.join(',') + '\n');

    const scale = Number(PRICE_SCALE);
    const fmt = (v: bigint): string => (Number(v) / scale).toFixed(8);

    for (const t of this.trades) {
      const row = [
        t.id,
        t.timestamp.toISOString(),
        t.buyLeg.venue,
        t.buyLeg.symbol,
        fmt(t.buyLeg.amount),
        fmt(t.buyLeg.price),
        fmt(t.buyLeg.fee),
        t.buyLeg.feeAsset,
        t.sellLeg.venue,
        t.sellLeg.symbol,
        fmt(t.sellLeg.amount),
        fmt(t.sellLeg.price),
        fmt(t.sellLeg.fee),
        t.sellLeg.feeAsset,
        fmt(t.gasCostUsd),
        fmt(t.grossPnl),
        fmt(t.totalFees),
        fmt(t.netPnl),
        Number(t.netPnlBps).toString(),
        fmt(t.notional),
      ];
      stream.write(row.join(',') + '\n');
    }

    stream.end();
    console.log(`[PnLEngine] exported ${this.trades.length} trades to ${filepath}`);
  }
}
