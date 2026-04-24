import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PRICE_SCALE } from '@/core/core.constants';
import { SignalGenerator } from '@/strategy/signal.generator';
import { FeeCalculator } from '@/strategy/fee.calculator';
import { Direction } from '@/strategy/signal.interfaces';
import { InventoryTracker } from '@/inventory/tracker/tracker.service';
import { Venue } from '@/inventory/tracker/tracker.interfaces';

function s(n: number): bigint {
  return BigInt(Math.round(n * Number(PRICE_SCALE)));
}

function makeOrderBook(bid: number, ask: number) {
  const bidScaled = s(bid);
  const askScaled = s(ask);
  const mid = (bidScaled + askScaled) / 2n;
  const spread = askScaled - bidScaled;
  const spreadBps = Number((spread * 10_000n) / mid);
  return {
    symbol: 'ETH/USDT',
    timestamp: Date.now(),
    bids: [[bidScaled, s(5)]] as [bigint, bigint][],
    asks: [[askScaled, s(5)]] as [bigint, bigint][],
    bestBid: [bidScaled, s(5)] as [bigint, bigint],
    bestAsk: [askScaled, s(5)] as [bigint, bigint],
    midPrice: mid,
    spreadBps,
  };
}

function makeExchangeClient(bid: number, ask: number) {
  return { fetchOrderBook: vi.fn().mockResolvedValue(makeOrderBook(bid, ask)) };
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

function makeGenerator(
  bid: number,
  ask: number,
  overrides: { minSpreadBps?: number; minProfit?: bigint; cooldownMs?: number } = {},
) {
  const exchangeClient = makeExchangeClient(bid, ask);
  const fees = new FeeCalculator({ cexTakerBps: 10, dexSwapBps: 30, gasCost: s(2) });
  const tracker = makeTracker();
  return {
    generator: new SignalGenerator(exchangeClient as never, null, tracker, fees, {
      minSpreadBps: overrides.minSpreadBps ?? 50,
      minProfit: overrides.minProfit ?? s(1),
      cooldownMs: overrides.cooldownMs ?? 0,
    }),
    exchangeClient,
  };
}

describe('SignalGenerator.generate — profitable opportunity', () => {
  beforeEach(() => {
    // Pin Math.random so stub DEX prices are deterministic: 100bps sell premium, 40bps buy discount.
    vi.spyOn(Math, 'random').mockReturnValue(0.667);
  });
  afterEach(() => vi.restoreAllMocks());

  it('generates signal when spread exceeds breakeven', async () => {
    // DEX stub prices: mid±0.5%, so buy@1005, sell@1008 relative to CEX mid ~2000
    // CEX bid=2000, ask=2001. Stub dexSell = mid*1.008 ≈ 2009, dexBuy = mid*1.005 ≈ 2005.
    // spread_b (buy DEX sell CEX): (2000 - 2005) / 2005 < 0 → no
    // spread_a (buy CEX sell DEX): (2009 - 2001) / 2001 ≈ 40 bps — below default 50 bps
    // Use wider spread: bid=1900, ask=1901 so dexSell ≈ 1913 vs ask 1901 → ~63 bps
    const { generator } = makeGenerator(1900, 1901, { minSpreadBps: 50, minProfit: s(0.01) });
    const signal = await generator.generate('ETH/USDT', s(1));
    expect(signal).not.toBeNull();
    expect(signal!.expectedNetPnl).toBeGreaterThan(0n);
  });
});

describe('SignalGenerator.generate — no opportunity', () => {
  it('returns null when spread is too small', async () => {
    // CEX bid=2000, ask=2001. Stub DEX prices centred on mid=2000.5, so
    // dexSell = 2000.5*1.008 ≈ 2016 relative to scaled — but minSpreadBps=500 makes it impossible.
    const { generator } = makeGenerator(2000, 2001, { minSpreadBps: 500 });
    const signal = await generator.generate('ETH/USDT', s(1));
    expect(signal).toBeNull();
  });
});

describe('SignalGenerator — cooldown', () => {
  beforeEach(() => vi.spyOn(Math, 'random').mockReturnValue(0.667));
  afterEach(() => vi.restoreAllMocks());

  it('second call within cooldown returns null', async () => {
    const { generator } = makeGenerator(1900, 1901, {
      minSpreadBps: 50,
      minProfit: s(0.01),
      cooldownMs: 60_000,
    });
    const first = await generator.generate('ETH/USDT', s(1));
    expect(first).not.toBeNull();
    const second = await generator.generate('ETH/USDT', s(1));
    expect(second).toBeNull();
  });
});

describe('SignalGenerator — direction selection', () => {
  beforeEach(() => vi.spyOn(Math, 'random').mockReturnValue(0.667));
  afterEach(() => vi.restoreAllMocks());

  it('picks BUY_CEX_SELL_DEX when that spread is larger', async () => {
    // CEX bid=2000, ask=2001. Stub: dexSell = mid*1.008 >> dexBuy = mid*1.005.
    // spread_a (buy CEX, sell DEX) uses dexSell vs ask → should be positive and win.
    const { generator } = makeGenerator(1900, 1901, { minSpreadBps: 10, minProfit: s(0.001) });
    const signal = await generator.generate('ETH/USDT', s(1));
    expect(signal?.direction).toBe(Direction.BUY_CEX_SELL_DEX);
  });
});
