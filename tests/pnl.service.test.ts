import { describe, it, expect } from 'vitest';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { PnLEngine } from '@/inventory/pnl/pnl.service';
import { ArbRecord, TradeLeg } from '@/inventory/pnl/pnl.interfaces';
import { Venue } from '@/inventory/tracker/tracker.interfaces';
import { PRICE_SCALE } from '@/exchange/cexClient/exchange.constants';

function s(n: number): bigint {
  return BigInt(Math.round(n * Number(PRICE_SCALE)));
}

function makeLeg(
  id: string,
  venue: Venue,
  side: 'buy' | 'sell',
  amount: number,
  price: number,
  fee: number,
): TradeLeg {
  return new TradeLeg(id, new Date(), venue, 'ETH/USDT', side, s(amount), s(price), s(fee), 'USDT');
}

function makeRecord(id: string, buyPrice: number, sellPrice: number, amount: number, fee = 0.5): ArbRecord {
  const buy  = makeLeg(`${id}-buy`,  Venue.WALLET,  'buy',  amount, buyPrice,  fee);
  const sell = makeLeg(`${id}-sell`, Venue.BINANCE, 'sell', amount, sellPrice, fee);
  return new ArbRecord(id, new Date(), buy, sell, 0n);
}

describe('ArbRecord computed properties', () => {
  it('gross PnL = (sellPrice - buyPrice) * amount', () => {
    const record = makeRecord('t1', 2000, 2010, 1.0, 0);

    // gross = (2010 - 2000) * 1.0 = 10 USDT
    expect(record.grossPnl).toBe(s(10));
  });

  it('net PnL = gross - buy fee - sell fee - gas', () => {
    const record = makeRecord('t2', 2000, 2010, 1.0, 1.0);

    // gross = 10, fees = 1 + 1 = 2, gas = 0 → net = 8
    expect(record.netPnl).toBe(s(8));
  });

  it('net PnL bps = netPnl / notional * 10000', () => {
    const record = makeRecord('t3', 2000, 2010, 1.0, 1.0);

    // notional = buyPrice * amount = 2000; netPnl = 8; bps = 8/2000*10000 = 40
    const expected = (record.netPnl * 10_000n) / record.notional;
    expect(record.netPnlBps).toBe(expected);
  });
});

describe('PnLEngine.summary', () => {
  it('returns all zeros when no trades recorded', () => {
    const engine = new PnLEngine();
    const summary = engine.summary();

    expect(summary.totalTrades).toBe(0);
    expect(summary.totalPnlUsd).toBe(0n);
    expect(summary.winRate).toBe(0);
    expect(summary.sharpeEstimate).toBeNaN();
  });

  it('win rate = profitable trades / total trades', () => {
    const engine = new PnLEngine();

    engine.record(makeRecord('w1', 2000, 2015, 1.0, 1.0)); // +13 → win
    engine.record(makeRecord('w2', 2000, 2015, 1.0, 1.0)); // +13 → win
    engine.record(makeRecord('l1', 2010, 2000, 1.0, 1.0)); // -22 → loss

    const summary = engine.summary();
    expect(summary.totalTrades).toBe(3);
    expect(summary.winRate).toBeCloseTo(2 / 3, 5);
  });

  it('total PnL is sum of all net PnLs', () => {
    const engine = new PnLEngine();
    const r1 = makeRecord('r1', 2000, 2010, 1.0, 1.0); // net = 8
    const r2 = makeRecord('r2', 2000, 2005, 1.0, 1.0); // net = 3

    engine.record(r1);
    engine.record(r2);

    expect(engine.summary().totalPnlUsd).toBe(r1.netPnl + r2.netPnl);
  });
});

describe('PnLEngine.exportCsv', () => {
  it('CSV has expected columns and correct row count', async () => {
    const engine = new PnLEngine();
    engine.record(makeRecord('csv1', 2000, 2010, 1.0, 1.0));
    engine.record(makeRecord('csv2', 2000, 2015, 0.5, 0.5));

    const path = '/tmp/pnl_test_export.csv';
    engine.exportCsv(path);

    // Stream writes are async — wait for the file to appear and settle.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const content = readFileSync(path, 'utf8');
    const lines = content.trim().split('\n');

    // Header + 2 data rows
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('id');
    expect(lines[0]).toContain('net_pnl');
    expect(lines[0]).toContain('gross_pnl');
    expect(lines[1]).toContain('csv1');
    expect(lines[2]).toContain('csv2');

    unlinkSync(path);
  });
});
