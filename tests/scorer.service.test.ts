import { vi, describe, it, expect } from 'vitest';
import { PRICE_SCALE } from '@/core/core.constants';
import { SignalScorer } from '@/strategy/scorer/scorer.service';
import { Signal, Direction } from '@/strategy/signal.interfaces';
import type { CheckResult } from '@/inventory/rebalancer/rebalancer.interfaces';

function s(n: number): bigint {
  return BigInt(Math.round(n * Number(PRICE_SCALE)));
}

function makeSignal(overrides: Partial<{
  spreadBps: number;
  score: number;
  pair: string;
  expiry: Date;
}>): Signal {
  const now = new Date();
  return new Signal({
    signalId: 'test_1234',
    pair: overrides.pair ?? 'ETH/USDT',
    direction: Direction.BUY_DEX_SELL_CEX,
    cexPrice: s(2000),
    dexPrice: s(1990),
    spreadBps: overrides.spreadBps ?? 100,
    size: s(1),
    expectedGrossPnl: s(20),
    expectedFees: s(8),
    expectedNetPnl: s(12),
    score: overrides.score ?? 60,
    timestamp: now,
    expiry: overrides.expiry ?? new Date(now.getTime() + 5_000),
    inventoryOk: true,
    withinLimits: true,
  });
}

function noChecks(): CheckResult[] {
  return [];
}

function redSkewChecks(asset = 'ETH'): CheckResult[] {
  return [{ asset, maxDeviationPct: 40, needsRebalance: true }];
}

describe('SignalScorer.score — spread', () => {
  it('100 bps spread scores high', () => {
    const scorer = new SignalScorer({ excellentSpreadBps: 100, minSpreadBps: 30 });
    const result = scorer.score(makeSignal({ spreadBps: 100 }), noChecks());
    expect(result).toBeGreaterThan(60);
  });

  it('spread below minimum scores low spread component', () => {
    const scorer = new SignalScorer({ excellentSpreadBps: 100, minSpreadBps: 30 });
    const result = scorer.score(makeSignal({ spreadBps: 10 }), noChecks());
    expect(result).toBeLessThan(60);
  });
});

describe('SignalScorer.score — inventory', () => {
  it('RED skew applies 20-point inventory penalty', () => {
    const scorer = new SignalScorer();
    const normal = scorer.score(makeSignal({ spreadBps: 100 }), noChecks());
    const skewed = scorer.score(makeSignal({ spreadBps: 100 }), redSkewChecks());
    expect(skewed).toBeLessThan(normal);
  });
});

describe('SignalScorer.applyDecay', () => {
  it('fresh signal has full score', () => {
    const scorer = new SignalScorer();
    const signal = makeSignal({ score: 80 });
    const decayed = scorer.applyDecay(signal);
    expect(decayed).toBeCloseTo(80, 0);
  });

  it('older signal near expiry has reduced score', () => {
    const scorer = new SignalScorer();
    const now = new Date();
    // Signal created 4.5s ago, expires in 0.5s → very close to expiry.
    const signal = makeSignal({
      score: 80,
      expiry: new Date(now.getTime() + 500),
    });
    // Manually age the signal by overriding timestamp via the params.
    const agedSignal = new Signal({
      ...signal,
      timestamp: new Date(now.getTime() - 4_500),
      expiry: new Date(now.getTime() + 500),
    });
    const decayed = scorer.applyDecay(agedSignal);
    expect(decayed).toBeLessThan(80);
  });
});
