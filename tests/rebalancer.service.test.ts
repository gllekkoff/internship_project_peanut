import { describe, it, expect } from 'vitest';
import { InventoryTracker } from '@/inventory/tracker/tracker.service';
import { RebalancePlanner } from '@/inventory/rebalancer/rebalancer.service';
import { Venue } from '@/inventory/tracker/tracker.interfaces';
import { PRICE_SCALE } from '@/exchange/cexClient/exchange.constants';

function s(n: number): bigint {
  return BigInt(Math.round(n * Number(PRICE_SCALE)));
}

function makeSkewedTracker() {
  // 80/20 split — exceeds 30% threshold
  const tracker = new InventoryTracker([Venue.BINANCE, Venue.WALLET]);
  tracker.updateFromCex(Venue.BINANCE, {
    ETH: { free: s(2), locked: 0n, total: s(2) },
  });
  tracker.updateFromWallet(Venue.WALLET, { ETH: s(8) });
  return tracker;
}

function makeBalancedTracker() {
  // 55/45 split — within 30% threshold
  const tracker = new InventoryTracker([Venue.BINANCE, Venue.WALLET]);
  tracker.updateFromCex(Venue.BINANCE, {
    ETH: { free: s(5.5), locked: 0n, total: s(5.5) },
  });
  tracker.updateFromWallet(Venue.WALLET, { ETH: s(4.5) });
  return tracker;
}

describe('RebalancePlanner.checkAll', () => {
  it('flags asset with 80/20 split for rebalance', () => {
    const planner = new RebalancePlanner(makeSkewedTracker());
    const results = planner.checkAll();
    const eth = results.find((r) => r.asset === 'ETH');

    expect(eth).toBeDefined();
    expect(eth!.needsRebalance).toBe(true);
  });

  it('does not flag asset with 55/45 split', () => {
    const planner = new RebalancePlanner(makeBalancedTracker());
    const results = planner.checkAll();
    const eth = results.find((r) => r.asset === 'ETH');

    expect(eth).toBeDefined();
    expect(eth!.needsRebalance).toBe(false);
  });
});

describe('RebalancePlanner.plan', () => {
  it('generates a transfer in the correct direction and amount', () => {
    const tracker = makeSkewedTracker();
    const planner = new RebalancePlanner(tracker);
    const plans = planner.plan('ETH');

    expect(plans.length).toBeGreaterThan(0);
    // Wallet has 8, Binance has 2 → should transfer FROM wallet TO binance
    expect(plans[0]!.fromVenue).toBe(Venue.WALLET);
    expect(plans[0]!.toVenue).toBe(Venue.BINANCE);
    // Should move enough to approach 50/50 (total=10, target=5 each, transfer ~3)
    expect(plans[0]!.amount).toBeGreaterThan(s(2));
  });

  it('returns empty list when asset is balanced', () => {
    const planner = new RebalancePlanner(makeBalancedTracker());
    expect(planner.plan('ETH')).toHaveLength(0);
  });

  it('net amount received = amount - fee', () => {
    const planner = new RebalancePlanner(makeSkewedTracker());
    const plans = planner.plan('ETH');

    for (const p of plans) {
      expect(p.netAmount).toBe(p.amount - p.estimatedFee);
    }
  });

  it('never plans transfer leaving sender below min operating balance', () => {
    // Wallet has just above min operating balance (0.5 ETH) + a little more
    const tracker = new InventoryTracker([Venue.BINANCE, Venue.WALLET]);
    tracker.updateFromCex(Venue.BINANCE, {
      ETH: { free: s(0.1), locked: 0n, total: s(0.1) },
    });
    // 0.6 ETH — only 0.1 above min operating balance of 0.5
    tracker.updateFromWallet(Venue.WALLET, { ETH: s(0.6) });

    const planner = new RebalancePlanner(tracker);
    const plans = planner.plan('ETH');

    // If any plan exists, the sender must retain >= 0.5 ETH (MIN_OPERATING_BALANCE)
    for (const p of plans) {
      const senderBalance = tracker.getAvailable(p.fromVenue as Venue, 'ETH');
      expect(senderBalance - p.amount).toBeGreaterThanOrEqual(s(0.5));
    }
  });
});

describe('RebalancePlanner.estimateCost', () => {
  it('total time is the max of all plan times (parallel execution)', () => {
    const planner = new RebalancePlanner(makeSkewedTracker());
    const plans = planner.plan('ETH');
    const cost = planner.estimateCost(plans);

    const maxTime = Math.max(...plans.map((p) => p.estimatedTimeMin));
    expect(cost.totalTimeMin).toBe(maxTime);
    expect(cost.totalTransfers).toBe(plans.length);
  });
});
