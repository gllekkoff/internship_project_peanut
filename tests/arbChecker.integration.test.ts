import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PRICE_SCALE } from '@/core/core.constants';
import { Venue } from '@/inventory/tracker/tracker.interfaces';

// ── Mock ccxt (same pattern as exchange.client.test.ts) ───────────────────────

vi.mock('ccxt', () => {
  const inst = {
    fetchTime:       vi.fn().mockResolvedValue(Date.now()),
    fetchOrderBook:  vi.fn(),
    fetchBalance:    vi.fn(),
    createOrder:     vi.fn(),
    cancelOrder:     vi.fn(),
    fetchOrder:      vi.fn(),
    fetchTradingFee: vi.fn(),
  };
  (globalThis as Record<string, unknown>)['__ccxtMockArb'] = inst;
  return {
    binance:             vi.fn(function () { return inst; }),
    AuthenticationError: class extends Error {},
    RateLimitExceeded:   class extends Error {},
    NetworkError:        class extends Error {},
    ExchangeError:       class extends Error {},
  };
});

import { ExchangeClient } from '@/exchange/cexClient/exchange.client';
import { InventoryTracker } from '@/inventory/tracker/tracker.service';
import { PnLEngine } from '@/inventory/pnl/pnl.service';
import { ArbChecker } from '@/integration/arbChecker/arbChecker.service';
import { UniswapV2Pair } from '@/pricing/uniswap-v2/uniswap-v2.service';
import { Address, Token } from '@/core/core.types';
import type { PricingEngine } from '@/pricing/engine/engine.service';
import { BINANCE_PROFILE } from '@/venues/binance/binance.profile';

function getMock() {
  return (globalThis as Record<string, unknown>)['__ccxtMockArb'] as Record<string, ReturnType<typeof vi.fn>>;
}

function s(n: number): bigint {
  return BigInt(Math.round(n * Number(PRICE_SCALE)));
}

function makeLevel(price: number, qty: number): [bigint, bigint] {
  return [s(price), s(qty)];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Builds a minimal UniswapV2Pair stub with controllable getAmountOut/getPriceImpactBps. */
function makePool(dexPrice: number, impactBps: number): UniswapV2Pair {
  const addr  = new Address('0x0000000000000000000000000000000000000001');
  const usdc  = new Token(new Address('0x0000000000000000000000000000000000000002'), 'USDC', 6);
  const weth  = new Token(new Address('0x0000000000000000000000000000000000000003'), 'WETH', 18);

  const pair = new UniswapV2Pair(addr, usdc, weth, 10_000_000_000n, 5_000_000_000_000_000_000n);

  // Stub the math methods to return controlled values.
  vi.spyOn(pair, 'getAmountOut').mockImplementation((_amountIn, _tokenIn) => {
    // Return quoteOut in native quoteToken decimals (6 for USDC): dexPrice * size
    // size = 2 ETH passed as native (2 * 1e18), return 2 * dexPrice USDC (in 1e6)
    const sizeEth = Number(_amountIn) / 1e18;
    return BigInt(Math.round(sizeEth * dexPrice * 1e6));
  });
  vi.spyOn(pair, 'getPriceImpactBps').mockReturnValue(BigInt(impactBps));

  return pair;
}

// Raw ccxt format — ExchangeClient.fetchOrderBook converts these to bigints internally.
function makeOrderBook(bid: number, ask: number) {
  return {
    symbol: 'ETH/USDT',
    timestamp: Date.now(),
    bids: [[bid, 10], [bid - 1, 20]],
    asks: [[ask, 10], [ask + 1, 20]],
  };
}

function makeTracker(quoteAmount: number, baseAmount: number): InventoryTracker {
  const tracker = new InventoryTracker([Venue.BINANCE, Venue.WALLET]);
  // buy_dex_sell_cex: quote (USDC) at dexVenue (WALLET), base (WETH) at cexVenue (BINANCE).
  tracker.updateFromWallet(Venue.WALLET, { USDC: s(quoteAmount) });
  tracker.updateFromCex(Venue.BINANCE, {
    WETH: { free: s(baseAmount), locked: 0n, total: s(baseAmount) },
  });
  return tracker;
}

function makeChecker(
  pool: UniswapV2Pair,
  tracker: InventoryTracker,
  tradeSize = 2.0,
): ArbChecker {
  const client = new ExchangeClient({ apiKey: 'k', secret: 's', sandbox: true, options: {}, enableRateLimit: false }, BINANCE_PROFILE);
  const pricingEngine = { loadPools: vi.fn(), refreshPool: vi.fn() } as unknown as PricingEngine;

  return new ArbChecker(pricingEngine, client, tracker, new PnLEngine(), [
    {
      pair: 'ETH/USDT',
      baseAsset: 'WETH',
      quoteAsset: 'USDC',
      cexSymbol: 'ETH/USDT',
      pool,
      tradeSize: s(tradeSize),
      dexFeeBps: 30,
      cexFeeBps: 10,
      gasCostUsd: 5,
      dexVenue: Venue.WALLET,
      cexVenue: Venue.BINANCE,
    },
  ]);
}

// ── Integration tests ─────────────────────────────────────────────────────────

describe('ArbChecker integration — profitable opportunity', () => {
  beforeEach(() => vi.clearAllMocks());

  it('detects buy-dex-sell-cex direction when CEX bid > DEX price', async () => {
    // DEX: $2,000  |  CEX bid: $2,050 → 250 bps gap, costs ~42 bps → profitable
    getMock()['fetchOrderBook'].mockResolvedValue(makeOrderBook(2050, 2051));

    const pool    = makePool(2000, 1);  // 1 bps price impact
    const tracker = makeTracker(10_000, 5);
    const checker = makeChecker(pool, tracker);

    const result = await checker.check('ETH/USDT');

    expect(result.direction).toBe('buy_dex_sell_cex');
    expect(result.gapBps).toBeGreaterThan(0);
    expect(result.estimatedNetPnlBps).toBeGreaterThan(0);
  });

  it('marks executable=true when gap > costs and inventory is sufficient', async () => {
    getMock()['fetchOrderBook'].mockResolvedValue(makeOrderBook(2050, 2051));

    const pool    = makePool(2000, 1);
    const tracker = makeTracker(10_000, 5);  // plenty of inventory
    const checker = makeChecker(pool, tracker);

    const result = await checker.check('ETH/USDT');

    expect(result.executable).toBe(true);
    expect(result.inventoryOk).toBe(true);
  });
});

describe('ArbChecker integration — unprofitable opportunity', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects when costs exceed the gap', async () => {
    // DEX: $2,007  |  CEX bid: $2,010 → only ~15 bps gap, costs ~42 bps → not profitable
    getMock()['fetchOrderBook'].mockResolvedValue(makeOrderBook(2010, 2011));

    const pool    = makePool(2007, 2);  // 2 bps price impact
    const tracker = makeTracker(10_000, 5);
    const checker = makeChecker(pool, tracker);

    const result = await checker.check('ETH/USDT');

    expect(result.estimatedNetPnlBps).toBeLessThan(0);
    expect(result.executable).toBe(false);
  });

  it('marks executable=false when no price gap exists', async () => {
    // DEX and CEX at same price — zero gap
    getMock()['fetchOrderBook'].mockResolvedValue(makeOrderBook(2000, 2001));

    const pool    = makePool(2000, 0);
    const tracker = makeTracker(10_000, 5);
    const checker = makeChecker(pool, tracker);

    const result = await checker.check('ETH/USDT');

    expect(result.gapBps).toBeLessThanOrEqual(0);
    expect(result.executable).toBe(false);
  });
});

describe('ArbChecker integration — inventory gate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('marks executable=false when inventory is insufficient despite profitable gap', async () => {
    // Big gap — would be profitable
    getMock()['fetchOrderBook'].mockResolvedValue(makeOrderBook(2050, 2051));

    const pool = makePool(2000, 1);
    // Only 1 USDT — not enough to buy 2 ETH at $2000
    const tracker = makeTracker(1, 0);
    const checker = makeChecker(pool, tracker);

    const result = await checker.check('ETH/USDT');

    expect(result.inventoryOk).toBe(false);
    expect(result.executable).toBe(false);
  });
});

describe('ArbChecker integration — unknown pair', () => {
  it('throws UnknownPairError for unconfigured pairs', async () => {
    getMock()['fetchOrderBook'].mockResolvedValue(makeOrderBook(2000, 2001));

    const pool    = makePool(2000, 0);
    const tracker = makeTracker(10_000, 5);
    const checker = makeChecker(pool, tracker);

    await expect(checker.check('BTC/USDT')).rejects.toThrow('BTC/USDT');
  });
});
