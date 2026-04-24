import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PRICE_SCALE } from '@/core/core.constants';
import { BINANCE_PROFILE } from '@/venues/binance/binance.profile';

// ── ccxt mock ─────────────────────────────────────────────────────────────────
// Must use a regular function (not arrow) so `new binance()` works as a constructor.
// Stored on globalThis so tests can access and reset the mock methods.

vi.mock('ccxt', () => {
  const inst = {
    fetchTime:      vi.fn().mockResolvedValue(Date.now()),
    fetchOrderBook: vi.fn(),
    fetchBalance:   vi.fn(),
    createOrder:    vi.fn(),
    cancelOrder:    vi.fn(),
    fetchOrder:     vi.fn(),
    fetchTradingFee: vi.fn(),
  };
  (globalThis as Record<string, unknown>)['__ccxtMock'] = inst;

  return {
    // Regular function — compatible with `new binance()`
    binance:            vi.fn(function () { return inst; }),
    AuthenticationError: class extends Error {},
    RateLimitExceeded:  class extends Error {},
    NetworkError:       class extends Error {},
    ExchangeError:      class extends Error {},
  };
});

import { ExchangeClient } from '@/exchange/cexClient/exchange.client';

function getMock() {
  return (globalThis as Record<string, unknown>)['__ccxtMock'] as Record<string, ReturnType<typeof vi.fn>>;
}

const VALID_CONFIG = { apiKey: 'key', secret: 'secret', sandbox: true, options: {}, enableRateLimit: false };

function makeRawBook(bid: number, ask: number) {
  return {
    timestamp: Date.now(),
    bids: [[bid, 5.0], [bid - 0.5, 10.0]],
    asks: [[ask, 4.0], [ask + 0.5, 8.0]],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ExchangeClient.fetchOrderBook', () => {
  let client: ExchangeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    getMock()['fetchTime'].mockResolvedValue(Date.now());
    client = new ExchangeClient(VALID_CONFIG, BINANCE_PROFILE);
  });

  it('order book has required fields', async () => {
    getMock()['fetchOrderBook'].mockResolvedValue(makeRawBook(2000, 2001));
    const book = await client.fetchOrderBook('ETH/USDT');

    expect(book).toHaveProperty('symbol');
    expect(book).toHaveProperty('bids');
    expect(book).toHaveProperty('asks');
    expect(book).toHaveProperty('bestBid');
    expect(book).toHaveProperty('bestAsk');
    expect(book).toHaveProperty('midPrice');
    expect(book).toHaveProperty('spreadBps');
  });

  it('bids sorted highest to lowest', async () => {
    getMock()['fetchOrderBook'].mockResolvedValue(makeRawBook(2000, 2001));
    const book = await client.fetchOrderBook('ETH/USDT');

    for (let i = 0; i < book.bids.length - 1; i++) {
      expect(book.bids[i]![0]).toBeGreaterThanOrEqual(book.bids[i + 1]![0]);
    }
  });

  it('asks sorted lowest to highest', async () => {
    getMock()['fetchOrderBook'].mockResolvedValue(makeRawBook(2000, 2001));
    const book = await client.fetchOrderBook('ETH/USDT');

    for (let i = 0; i < book.asks.length - 1; i++) {
      expect(book.asks[i]![0]).toBeLessThanOrEqual(book.asks[i + 1]![0]);
    }
  });

  it('spread = best_ask - best_bid in bps', async () => {
    getMock()['fetchOrderBook'].mockResolvedValue(makeRawBook(2000, 2001));
    const book = await client.fetchOrderBook('ETH/USDT');

    const expectedBps = ((book.bestAsk[0] - book.bestBid[0]) * 10_000n) / book.midPrice;
    expect(book.spreadBps).toBe(expectedBps);
  });
});

describe('ExchangeClient.fetchBalance', () => {
  let client: ExchangeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    getMock()['fetchTime'].mockResolvedValue(Date.now());
    client = new ExchangeClient(VALID_CONFIG, BINANCE_PROFILE);
  });

  it('zero-balance assets excluded from result', async () => {
    getMock()['fetchBalance'].mockResolvedValue({
      ETH:  { free: 1.5, used: 0,   total: 1.5 },
      BTC:  { free: 0,   used: 0,   total: 0   },
      USDT: { free: 500, used: 100, total: 600 },
      info: {},
    });

    const result = await client.fetchBalance();

    expect(result).toHaveProperty('ETH');
    expect(result).toHaveProperty('USDT');
    expect(result).not.toHaveProperty('BTC');
  });

  it('free and locked amounts scaled correctly', async () => {
    getMock()['fetchBalance'].mockResolvedValue({
      ETH: { free: 1.0, used: 0.5, total: 1.5 },
    });

    const result = await client.fetchBalance();
    expect(result['ETH']!.free).toBe(BigInt(Math.round(1.0 * Number(PRICE_SCALE))));
    expect(result['ETH']!.locked).toBe(BigInt(Math.round(0.5 * Number(PRICE_SCALE))));
  });
});

describe('ExchangeClient.createLimitIocOrder', () => {
  let client: ExchangeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    getMock()['fetchTime'].mockResolvedValue(Date.now());
    client = new ExchangeClient(VALID_CONFIG, BINANCE_PROFILE);
  });

  it('returns fill qty, avg price, and fees', async () => {
    getMock()['createOrder'].mockResolvedValue({
      id: 'ord-1',
      symbol: 'ETH/USDT',
      side: 'buy',
      type: 'limit',
      timeInForce: 'IOC',
      amount: 1.0,
      filled: 0.8,
      average: 2001.5,
      fee: { cost: 0.5, currency: 'USDT' },
      status: 'closed',
      timestamp: Date.now(),
    });

    const result = await client.createLimitIocOrder('ETH/USDT', 'buy', 1.0, 2001.5);

    expect(result.amountFilled).toBe(BigInt(Math.round(0.8 * Number(PRICE_SCALE))));
    expect(result.avgFillPrice).toBe(BigInt(Math.round(2001.5 * Number(PRICE_SCALE))));
    expect(result.fee).toBe(BigInt(Math.round(0.5 * Number(PRICE_SCALE))));
    expect(result.feeAsset).toBe('USDT');
  });
});

describe('ExchangeClient rate limiter', () => {
  it('blocks when weight limit is exhausted', async () => {
    vi.clearAllMocks();
    getMock()['fetchTime'].mockResolvedValue(Date.now());
    getMock()['fetchOrderBook'].mockResolvedValue(makeRawBook(2000, 2001));

    const client = new ExchangeClient(VALID_CONFIG, BINANCE_PROFILE);

    // Pre-fill weight log via private field to simulate exhausted budget.
    const now = Date.now();
    (client as unknown as Record<string, unknown>)['weightLog'] = Array.from(
      { length: BINANCE_PROFILE.rateLimit.weightLimit },
      () => ({ time: now, weight: 1 }),
    );

    vi.useFakeTimers();
    const sleepSpy = vi.spyOn(global, 'setTimeout');
    const fetchPromise = client.fetchOrderBook('ETH/USDT');
    await vi.runAllTimersAsync();
    await fetchPromise;

    expect(sleepSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
