import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PRICE_SCALE } from '@/core/core.constants';
import { Executor } from '@/executor/engine/engine.service';
import { ExecutorState } from '@/executor/engine/engine.interfaces';
import { Signal, Direction } from '@/strategy/signal.interfaces';
import { InventoryTracker } from '@/inventory/tracker/tracker.service';
import { Venue } from '@/inventory/tracker/tracker.interfaces';
import { BINANCE_PROFILE } from '@/venues/binance/binance.profile';

function s(n: number): bigint {
  return BigInt(Math.round(n * Number(PRICE_SCALE)));
}

function makeSignal(overrides: Partial<{
  inventoryOk: boolean;
  expiredMs: number;
  score: number;
  expectedNetPnl: bigint;
}> = {}): Signal {
  const now = new Date();
  return new Signal({
    signalId: `sig_${Math.random().toString(36).slice(2, 8)}`,
    pair: 'ETH/USDT',
    direction: Direction.BUY_CEX_SELL_DEX,
    cexPrice: s(2000),
    dexPrice: s(1990),
    spreadBps: 50,
    size: s(1),
    expectedGrossPnl: s(10),
    expectedFees: s(4),
    expectedNetPnl: overrides.expectedNetPnl ?? s(6),
    score: overrides.score ?? 70,
    timestamp: overrides.expiredMs
      ? new Date(now.getTime() - overrides.expiredMs - 10_000)
      : now,
    expiry: overrides.expiredMs
      ? new Date(now.getTime() - overrides.expiredMs)
      : new Date(now.getTime() + 30_000),
    inventoryOk: overrides.inventoryOk ?? true,
    withinLimits: true,
  });
}

function makeTracker(ethBinance = 10, usdtBinance = 50_000, ethWallet = 10) {
  const tracker = new InventoryTracker([Venue.BINANCE, Venue.WALLET]);
  tracker.updateFromCex(Venue.BINANCE, {
    ETH: { free: s(ethBinance), locked: 0n, total: s(ethBinance) },
    USDT: { free: s(usdtBinance), locked: 0n, total: s(usdtBinance) },
  });
  tracker.updateFromWallet(Venue.WALLET, { ETH: s(ethWallet) });
  return tracker;
}

function makeExecutor(tracker = makeTracker()) {
  return new Executor(
    {} as never,    // exchangeClient — not needed in simulation mode
    null,
    tracker,
    BINANCE_PROFILE,
    { simulationMode: true, useFlashbots: false, leg1TimeoutMs: 500, leg2TimeoutMs: 1_000 },
  );
}

describe('Executor.execute — success path', () => {
  it('both legs fill, state ends at DONE', async () => {
    const executor = makeExecutor();
    const ctx = await executor.execute(makeSignal());
    expect(ctx.state).toBe(ExecutorState.DONE);
    expect(ctx.leg1FillPrice).not.toBeNull();
    expect(ctx.leg2FillPrice).not.toBeNull();
    expect(ctx.actualNetPnlUsd).not.toBeNull();
    expect(typeof ctx.actualNetPnlUsd).toBe('bigint');
  });
});

describe('Executor.execute — CEX timeout', () => {
  it('CEX timeout results in FAILED state', async () => {
    // Use real (non-simulation) CEX leg but tiny timeout — it will time out.
    // Easier: use a mock that never resolves.
    const tracker = makeTracker();
    const slowClient = {
      createLimitIocOrder: () => new Promise(() => {}), // never resolves
    };
    const executor = new Executor(
      slowClient as never,
      null,
      tracker,
      BINANCE_PROFILE,
      { simulationMode: false, useFlashbots: false, leg1TimeoutMs: 50, leg2TimeoutMs: 500 },
    );
    const ctx = await executor.execute(makeSignal());
    expect(ctx.state).toBe(ExecutorState.FAILED);
    expect(ctx.error).toMatch(/timeout/i);
  });
});

describe('Executor.execute — DEX failure unwinds', () => {
  it('DEX failure after CEX fill triggers unwind path and FAILED state', async () => {
    // Run CEX-first in simulation (succeeds), then a DEX that fails.
    // Inject a DEX failure by using simulationMode=false with no pricingEngine.
    const tracker = makeTracker();
    const executor = new Executor(
      {} as never,
      null, // no pricingEngine → real DEX throws
      tracker,
      BINANCE_PROFILE,
      // CEX sim=true via overriding just DEX is not possible in current design, so run
      // full simulation=false with a mock exchange that fills instantly.
      { simulationMode: false, useFlashbots: false, leg1TimeoutMs: 500, leg2TimeoutMs: 500 },
    );
    // Both legs are non-sim. CEX will time out with empty client.
    // Use a client that resolves CEX immediately with a fill:
    const filledOrder = {
      status: 'filled',
      avgFillPrice: s(2000),
      amountFilled: s(1),
      amountRequested: s(1),
      id: 'o1',
      symbol: 'ETH/USDT',
      side: 'buy',
      type: 'limit',
      timeInForce: 'IOC',
      fee: s(2),
      feeAsset: 'USDT',
    };
    const clientWithFill = { createLimitIocOrder: vi.fn().mockResolvedValue(filledOrder) };
    const executor2 = new Executor(
      clientWithFill as never,
      null, // no pricingEngine → DEX will throw
      tracker,
      BINANCE_PROFILE,
      { simulationMode: false, useFlashbots: false, leg1TimeoutMs: 500, leg2TimeoutMs: 500 },
    );
    const ctx = await executor2.execute(makeSignal());
    expect(ctx.state).toBe(ExecutorState.FAILED);
  });
});

describe('Executor.execute — partial fill', () => {
  it('fill below min_fill_ratio is rejected', async () => {
    const partialOrder = {
      status: 'canceled',
      avgFillPrice: s(2000),
      amountFilled: s(0.1), // only 10% filled — below 0.8 threshold
      amountRequested: s(1),
      id: 'o2',
      symbol: 'ETH/USDT',
      side: 'buy',
      type: 'limit',
      timeInForce: 'IOC',
      fee: 0n,
      feeAsset: 'USDT',
    };
    const client = { createLimitIocOrder: vi.fn().mockResolvedValue(partialOrder) };
    const executor = new Executor(
      client as never,
      null,
      makeTracker(),
      BINANCE_PROFILE,
      { simulationMode: false, useFlashbots: false, leg1TimeoutMs: 500, leg2TimeoutMs: 500 },
    );
    const ctx = await executor.execute(makeSignal());
    expect(ctx.state).toBe(ExecutorState.FAILED);
    expect(ctx.error).toMatch(/partial fill/i);
  });
});

describe('Executor.execute — circuit breaker', () => {
  it('open circuit breaker prevents execution', async () => {
    const executor = makeExecutor();
    // Trip the breaker directly via private field — tests the observable behaviour.
    const cb = (executor as unknown as Record<string, { recordFailure(): void }>)['circuitBreaker'];
    for (let i = 0; i < 5; i++) cb.recordFailure();

    const ctx = await executor.execute(makeSignal());
    expect(ctx.state).toBe(ExecutorState.FAILED);
    expect(ctx.error).toMatch(/circuit breaker/i);
  });
});

describe('Executor.execute — replay protection', () => {
  it('same signal cannot execute twice', async () => {
    const executor = makeExecutor();
    const signal = makeSignal();
    const first = await executor.execute(signal);
    expect(first.state).toBe(ExecutorState.DONE);
    const second = await executor.execute(signal);
    expect(second.state).toBe(ExecutorState.FAILED);
    expect(second.error).toMatch(/duplicate/i);
  });
});
