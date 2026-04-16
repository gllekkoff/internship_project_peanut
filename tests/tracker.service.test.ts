import { describe, it, expect, beforeEach } from 'vitest';
import { InventoryTracker } from '@/inventory/tracker/tracker.service';
import { Venue } from '@/inventory/tracker/tracker.interfaces';
import { PRICE_SCALE } from '@/exchange/cexClient/exchange.constants';

function s(n: number): bigint {
  return BigInt(Math.round(n * Number(PRICE_SCALE)));
}

function makeTracker() {
  const tracker = new InventoryTracker([Venue.BINANCE, Venue.WALLET]);
  tracker.updateFromCex(Venue.BINANCE, {
    ETH:  { free: s(2),     locked: 0n,  total: s(2) },
    USDT: { free: s(4000),  locked: 0n,  total: s(4000) },
  });
  tracker.updateFromWallet(Venue.WALLET, {
    ETH:  s(8),
    USDT: s(6000),
  });
  return tracker;
}

describe('InventoryTracker.snapshot', () => {
  it('aggregates totals across venues', () => {
    const tracker = makeTracker();
    const snap = tracker.snapshot();

    // ETH: 2 binance + 8 wallet = 10
    expect(snap.totals['ETH']).toBe(s(10));
    // USDT: 4000 + 6000 = 10000
    expect(snap.totals['USDT']).toBe(s(10000));
  });
});

describe('InventoryTracker.canExecute', () => {
  it('returns true when both sides have sufficient balance', () => {
    const tracker = makeTracker();

    const result = tracker.canExecute(
      Venue.WALLET, 'USDT', s(5000),  // has 6000
      Venue.BINANCE, 'ETH',  s(1),    // has 2
    );

    expect(result.canExecute).toBe(true);
    expect(result.reason).toBeNull();
  });

  it('returns false when buy venue lacks funds', () => {
    const tracker = makeTracker();

    const result = tracker.canExecute(
      Venue.WALLET, 'USDT', s(9000),  // has 6000 — insufficient
      Venue.BINANCE, 'ETH',  s(1),
    );

    expect(result.canExecute).toBe(false);
    expect(result.reason).toContain('USDT');
  });

  it('returns false when sell venue lacks asset', () => {
    const tracker = makeTracker();

    const result = tracker.canExecute(
      Venue.WALLET, 'USDT', s(100),
      Venue.BINANCE, 'ETH',  s(5),  // has 2 — insufficient
    );

    expect(result.canExecute).toBe(false);
    expect(result.reason).toContain('ETH');
  });
});

describe('InventoryTracker.recordTrade', () => {
  it('buy: base increases, quote decreases, fee deducted', () => {
    const tracker = makeTracker();

    // Buy 1 ETH for 2000 USDT, fee 2 USDT
    tracker.recordTrade(Venue.BINANCE, 'buy', 'ETH', 'USDT', s(1), s(2000), s(2), 'USDT');

    // ETH: 2 + 1 = 3
    expect(tracker.getAvailable(Venue.BINANCE, 'ETH')).toBe(s(3));
    // USDT: 4000 - 2000 - 2 = 1998
    expect(tracker.getAvailable(Venue.BINANCE, 'USDT')).toBe(s(1998));
  });

  it('sell: base decreases, quote increases, fee deducted', () => {
    const tracker = makeTracker();

    // Sell 1 ETH for 2000 USDT, fee 2 USDT
    tracker.recordTrade(Venue.BINANCE, 'sell', 'ETH', 'USDT', s(1), s(2000), s(2), 'USDT');

    // ETH: 2 - 1 = 1
    expect(tracker.getAvailable(Venue.BINANCE, 'ETH')).toBe(s(1));
    // USDT: 4000 + 2000 - 2 = 5998
    expect(tracker.getAvailable(Venue.BINANCE, 'USDT')).toBe(s(5998));
  });
});

describe('InventoryTracker.skew', () => {
  it('80/20 split shows >= 30% deviation and triggers rebalance', () => {
    const tracker = new InventoryTracker([Venue.BINANCE, Venue.WALLET]);
    tracker.updateFromCex(Venue.BINANCE, {
      ETH: { free: s(2), locked: 0n, total: s(2) },
    });
    tracker.updateFromWallet(Venue.WALLET, { ETH: s(8) });

    const skew = tracker.skew('ETH');

    expect(skew.maxDeviationPct).toBeCloseTo(30, 1);
    expect(skew.needsRebalance).toBe(true);
  });

  it('50/50 split shows ~0% deviation and does not trigger rebalance', () => {
    const tracker = new InventoryTracker([Venue.BINANCE, Venue.WALLET]);
    tracker.updateFromCex(Venue.BINANCE, {
      ETH: { free: s(5), locked: 0n, total: s(5) },
    });
    tracker.updateFromWallet(Venue.WALLET, { ETH: s(5) });

    const skew = tracker.skew('ETH');

    expect(skew.maxDeviationPct).toBeCloseTo(0, 1);
    expect(skew.needsRebalance).toBe(false);
  });

  it('getSkews returns one entry per tracked asset', () => {
    const tracker = makeTracker();
    const skews = tracker.getSkews();
    const assets = skews.map((s) => s.asset);

    expect(assets).toContain('ETH');
    expect(assets).toContain('USDT');
    expect(skews.length).toBe(2);
  });
});
