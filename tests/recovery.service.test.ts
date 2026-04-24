import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker, ReplayProtection } from '@/executor/recovery/recovery.service';
import { Signal, Direction } from '@/strategy/signal.interfaces';
import { PRICE_SCALE } from '@/core/core.constants';

function s(n: number): bigint {
  return BigInt(Math.round(n * Number(PRICE_SCALE)));
}

function makeSignal(id: string): Signal {
  const now = new Date();
  return new Signal({
    signalId: id,
    pair: 'ETH/USDT',
    direction: Direction.BUY_DEX_SELL_CEX,
    cexPrice: s(2000),
    dexPrice: s(1990),
    spreadBps: 50,
    size: s(1),
    expectedGrossPnl: s(10),
    expectedFees: s(4),
    expectedNetPnl: s(6),
    score: 70,
    timestamp: now,
    expiry: new Date(now.getTime() + 5_000),
    inventoryOk: true,
    withinLimits: true,
  });
}

describe('CircuitBreaker', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('3 failures in window trips breaker', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, windowMs: 60_000, cooldownMs: 300_000 });
    expect(cb.isOpen()).toBe(false);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(false);
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
  });

  it('breaker resets after cooldown elapses', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, windowMs: 60_000, cooldownMs: 1_000 });
    cb.recordFailure(); cb.recordFailure(); cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
    vi.advanceTimersByTime(1_001);
    expect(cb.isOpen()).toBe(false);
  });

  it('failures outside the window are not counted', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, windowMs: 1_000, cooldownMs: 300_000 });
    cb.recordFailure(); cb.recordFailure();
    vi.advanceTimersByTime(1_100); // both failures fall outside the 1s window
    cb.recordFailure(); // only 1 in-window failure
    expect(cb.isOpen()).toBe(false);
  });
});

describe('ReplayProtection', () => {
  it('same signal_id is blocked after marking', () => {
    const rp = new ReplayProtection({ ttlMs: 60_000 });
    const sig = makeSignal('sig_abc');
    expect(rp.isDuplicate(sig)).toBe(false);
    rp.markExecuted(sig);
    expect(rp.isDuplicate(sig)).toBe(true);
  });

  it('different signal_id is allowed', () => {
    const rp = new ReplayProtection({ ttlMs: 60_000 });
    rp.markExecuted(makeSignal('sig_abc'));
    expect(rp.isDuplicate(makeSignal('sig_xyz'))).toBe(false);
  });

  it('signal is allowed again after TTL expires', () => {
    vi.useFakeTimers();
    const rp = new ReplayProtection({ ttlMs: 1_000 });
    const sig = makeSignal('sig_ttl');
    rp.markExecuted(sig);
    expect(rp.isDuplicate(sig)).toBe(true);
    vi.advanceTimersByTime(1_100);
    expect(rp.isDuplicate(sig)).toBe(false);
    vi.useRealTimers();
  });
});
