#!/usr/bin/env tsx
/**
 * PnL dashboard CLI.
 * Usage: npx tsx src/scripts/pnl.script.ts --summary
 */
import { PRICE_SCALE } from '@/exchange/cexClient/exchange.constants';
import { Venue } from '@/inventory/tracker/tracker.interfaces';
import { ArbRecord, TradeLeg } from '@/inventory/pnl/pnl.interfaces';
import { PnLEngine } from '@/inventory/pnl/pnl.service';

// ── Demo data ─────────────────────────────────────────────────────────────────

function scaled(human: number): bigint {
  return BigInt(Math.round(human * Number(PRICE_SCALE)));
}

function makeLeg(
  id: string,
  minsAgo: number,
  venue: Venue,
  side: 'buy' | 'sell',
  amount: number,
  price: number,
): TradeLeg {
  const ts = new Date(Date.now() - minsAgo * 60_000);
  // 0.5 bps fee per leg — realistic for a maker-tier CEX account.
  const fee = amount * price * 0.00005;
  return new TradeLeg(
    id,
    ts,
    venue,
    'ETH/USDT',
    side,
    scaled(amount),
    scaled(price),
    scaled(fee),
    'USDT',
  );
}

const engine = new PnLEngine();

// [minsAgo, buyPrice, sellPrice, amount] — buy on DEX (wallet), sell on CEX (Binance).
// sellPrice > buyPrice = winner; sellPrice < buyPrice = loser.
const trades: Array<[number, number, number, number]> = [
  [2, 2009.5, 2009.8, 0.62],
  [4, 2009.4, 2009.7, 0.6],
  [7, 2009.6, 2009.3, 0.6],
  [10, 2009.2, 2009.8, 0.9],
  [13, 2008.9, 2009.5, 0.75],
  [16, 2009.1, 2009.0, 0.55],
  [19, 2008.7, 2009.4, 0.8],
  [22, 2009.0, 2009.6, 0.7],
];

for (let i = 0; i < 47; i++) {
  const [minsAgo, buyPrice, sellPrice, amount] = trades[i % trades.length]!;
  const shift = (i * 0.03) % 0.5;
  // Alternate direction: even = buy DEX sell CEX, odd = buy CEX sell DEX.
  const buyVenue = i % 2 === 0 ? Venue.WALLET : Venue.BINANCE;
  const sellVenue = i % 2 === 0 ? Venue.BINANCE : Venue.WALLET;
  const buy = makeLeg(`buy-${i + 1}`, minsAgo + i * 0.5, buyVenue, 'buy', amount, buyPrice + shift);
  const sell = makeLeg(
    `sell-${i + 1}`,
    minsAgo + i * 0.5,
    sellVenue,
    'sell',
    amount,
    sellPrice + shift,
  );
  engine.record(new ArbRecord(`arb-${i + 1}`, buy.timestamp, buy, sell, scaled(0.05)));
}

// ── Formatting helpers ─────────────────────────────────────────────────────────

const SEP = '═'.repeat(43);

function usd(v: bigint): string {
  const n = Number(v) / Number(PRICE_SCALE);
  const sign = n >= 0 ? '' : '-';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function bps(v: bigint): string {
  return `${Number(v).toFixed(1)} bps`;
}

// ── --summary ─────────────────────────────────────────────────────────────────

function runSummary(): void {
  const s = engine.summary();
  const recent = engine.recent(4);

  console.log('\nPnL Summary (last 24h)');
  console.log(SEP);
  console.log(`Total Trades:        ${s.totalTrades}`);
  console.log(`Win Rate:            ${(s.winRate * 100).toFixed(1)}%`);
  console.log(`Total PnL:           ${usd(s.totalPnlUsd)}`);
  console.log(`Total Fees:          ${usd(s.totalFeesUsd)}`);
  console.log(`Avg PnL/Trade:       ${usd(s.avgPnlPerTrade)}`);
  console.log(`Avg PnL (bps):       ${bps(s.avgPnlBps)}`);
  console.log(`Best Trade:          ${usd(s.bestTradePnl)}`);
  console.log(`Worst Trade:         ${usd(s.worstTradePnl)}`);
  console.log(
    `Total Notional:      $${(Number(s.totalNotional) / Number(PRICE_SCALE)).toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
  );

  console.log('\nRecent Trades:');
  for (const t of recent) {
    const time = t.timestamp.toISOString().slice(11, 16);
    const base = t.symbol.split('/')[0]!;
    const direction = `Buy ${t.buyVenue} / Sell ${t.sellVenue}`;
    const pnlStr = `${t.netPnl >= 0n ? '+' : ''}${usd(t.netPnl)} (${Number(t.netPnlBps).toFixed(1)} bps)`;
    const icon = t.netPnl >= 0n ? '✅' : '❌';
    console.log(`  ${time}  ${base}  ${direction}  ${pnlStr} ${icon}`);
  }

  console.log();
}

// ── Dispatch ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--summary')) {
  runSummary();
} else {
  console.log('Usage: --summary   Show PnL summary and recent trades');
}
