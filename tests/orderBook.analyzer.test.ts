import { describe, it, expect } from 'vitest';
import { OrderBookAnalyzer } from '@/exchange/orderBook/orderBook.analyzer';
import { PRICE_SCALE } from '@/core/core.constants';
import type { OrderBook } from '@/exchange/cexClient/exchange.interfaces';

function s(n: number): bigint {
  return BigInt(Math.round(n * Number(PRICE_SCALE)));
}

function makeBook(overrides: Partial<OrderBook> = {}): OrderBook {
  return {
    symbol: 'ETH/USDT',
    timestamp: Date.now(),
    bids: [
      [s(2000), s(5.0)],
      [s(1999), s(8.0)],
      [s(1998), s(12.0)],
    ],
    asks: [
      [s(2001), s(4.0)],
      [s(2002), s(9.0)],
      [s(2003), s(15.0)],
    ],
    bestBid: [s(2000), s(5.0)],
    bestAsk: [s(2001), s(4.0)],
    midPrice: s(2000.5),
    spreadBps: 5n,
    ...overrides,
  };
}

describe('OrderBookAnalyzer.walkTheBook', () => {
  it('fills exactly at one price level', () => {
    const book = makeBook();
    const analyzer = new OrderBookAnalyzer(book);

    // 4 ETH fits entirely in the first ask level (4.0 ETH @ 2001)
    const result = analyzer.walkTheBook('buy', 4.0);

    expect(result.fullyFilled).toBe(true);
    expect(result.levelsConsumed).toBe(1);
    expect(result.avgPrice).toBe(s(2001));
    expect(result.slippageBps).toBe(0n);
  });

  it('fills across multiple levels with correct avg price', () => {
    const book = makeBook();
    const analyzer = new OrderBookAnalyzer(book);

    // 10 ETH: 4 @ 2001 + 6 @ 2002
    const result = analyzer.walkTheBook('buy', 10.0);

    expect(result.fullyFilled).toBe(true);
    expect(result.levelsConsumed).toBe(2);

    // avgPrice = totalCost / totalQty
    const expectedCost = s(4.0 * 2001 + 6.0 * 2002);
    const expectedAvg = (expectedCost * PRICE_SCALE) / s(10.0);
    // allow small rounding tolerance
    const diff = result.avgPrice > expectedAvg
      ? result.avgPrice - expectedAvg
      : expectedAvg - result.avgPrice;
    expect(diff).toBeLessThanOrEqual(2n);
  });

  it('returns fullyFilled=false when book too thin', () => {
    // Total asks: 4 + 9 + 15 = 28 ETH — ask for 50
    const book = makeBook();
    const analyzer = new OrderBookAnalyzer(book);

    const result = analyzer.walkTheBook('buy', 50.0);

    expect(result.fullyFilled).toBe(false);
  });
});

describe('OrderBookAnalyzer.depthAtBps', () => {
  it('matches manual calculation at 10 bps', () => {
    const book = makeBook();
    const analyzer = new OrderBookAnalyzer(book);

    // Best ask = 2001; 10 bps range = 2001 * 10/10000 = $2.001 → up to 2003.001
    // Levels within range: 2001 (4), 2002 (9), 2003 (15) — all three
    const depth = analyzer.depthAtBps('ask', 10);

    expect(depth).toBe(s(4.0) + s(9.0) + s(15.0));
  });

  it('excludes levels outside the bps range', () => {
    const book = makeBook();
    const analyzer = new OrderBookAnalyzer(book);

    // Best bid = 2000; 1 bps = $0.20 → only 2000 qualifies (1999 is 5bps away)
    const depth = analyzer.depthAtBps('bid', 1);

    expect(depth).toBe(s(5.0));
  });
});

describe('OrderBookAnalyzer.imbalance', () => {
  it('always returns value in [-1.0, +1.0]', () => {
    const book = makeBook();
    const analyzer = new OrderBookAnalyzer(book);

    const imbal = analyzer.imbalance(10);
    expect(imbal).toBeGreaterThanOrEqual(-1.0);
    expect(imbal).toBeLessThanOrEqual(1.0);
  });

  it('returns +1 when only bids exist', () => {
    const book = makeBook({
      asks: [],
      bestAsk: [s(2001), s(0)],
    });
    const analyzer = new OrderBookAnalyzer(book);

    expect(analyzer.imbalance(10)).toBe(1);
  });

  it('returns -1 when only asks exist', () => {
    const book = makeBook({
      bids: [],
      bestBid: [s(2000), s(0)],
    });
    const analyzer = new OrderBookAnalyzer(book);

    expect(analyzer.imbalance(10)).toBe(-1);
  });
});

describe('OrderBookAnalyzer.effectiveSpread', () => {
  it('effective spread >= quoted spread for qty > 0', () => {
    const book = makeBook();
    const analyzer = new OrderBookAnalyzer(book);

    const effective = analyzer.effectiveSpread(5.0);
    const quoted = book.spreadBps;

    expect(effective).toBeGreaterThanOrEqual(quoted);
  });

  it('returns 0 when mid price is zero', () => {
    const book = makeBook({ midPrice: 0n });
    const analyzer = new OrderBookAnalyzer(book);

    expect(analyzer.effectiveSpread(1.0)).toBe(0n);
  });
});
