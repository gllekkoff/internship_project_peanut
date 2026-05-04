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

const ETH_TOKEN = { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const, decimals: 18, symbol: 'ETH' };
const USDT_TOKEN = { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7' as const, decimals: 6, symbol: 'USDT' };

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

/**
 * Makes a pricing engine mock where:
 * - selling ETH→USDT yields `dexSellPremiumBps` bps above the CEX ask price
 * - buying ETH←USDT yields `dexBuyDiscountBps` bps below the CEX bid price
 *
 * The mock intercepts `getAmmQuote(tokenIn, tokenOut, amountIn)` and returns
 * a proportionally adjusted amount based on which direction is being quoted.
 */
function makePricingEngine(dexSellPremiumBps = 100, dexBuyDiscountBps = 0) {
  return {
    getAmmQuote: vi.fn((tokenIn: typeof ETH_TOKEN, _tokenOut: typeof USDT_TOKEN, amountIn: bigint): bigint => {
      if (tokenIn.symbol === 'ETH') {
        // ETH→USDT: sell path — return more USDT than at CEX mid to create a sell premium.
        // amountIn is in ETH raw units (18 decimals). Return USDT raw units (6 decimals).
        // ~2000 USDC/ETH * (1 + premium). Scale: 1 ETH = 1e18 wei, 1 USDC = 1e6.
        const ethAmount = Number(amountIn) / 1e18;
        const usdcOut = ethAmount * 2000 * (1 + dexSellPremiumBps / 10_000);
        return BigInt(Math.round(usdcOut * 1e6));
      } else {
        // USDT→ETH: buy path — return more ETH than at CEX mid to create a buy discount.
        const usdcAmount = Number(amountIn) / 1e6;
        const ethOut = (usdcAmount / 2000) * (1 + dexBuyDiscountBps / 10_000);
        return BigInt(Math.round(ethOut * 1e18));
      }
    }),
  };
}

function makeGenerator(
  bid: number,
  ask: number,
  overrides: {
    minSpreadBps?: number;
    minProfit?: bigint;
    cooldownMs?: number;
    dexSellPremiumBps?: number;
    dexBuyDiscountBps?: number;
  } = {},
) {
  const exchangeClient = makeExchangeClient(bid, ask);
  const fees = new FeeCalculator({ cexTakerBps: 10, dexSwapBps: 30, gasCost: 0n });
  const tracker = makeTracker();
  const pricingEngine = makePricingEngine(overrides.dexSellPremiumBps, overrides.dexBuyDiscountBps);
  const pairTokens = new Map([['ETH/USDT', [ETH_TOKEN, USDT_TOKEN] as const]]);
  return {
    generator: new SignalGenerator(exchangeClient as never, pricingEngine as never, tracker, fees, {
      minSpreadBps: overrides.minSpreadBps ?? 50,
      minProfit: overrides.minProfit ?? s(1),
      cooldownMs: overrides.cooldownMs ?? 0,
      tradeSizeUsd: 18n * PRICE_SCALE,
      pairTokens,
      senderAddress: '0x0000000000000000000000000000000000000001',
    }),
    exchangeClient,
    pricingEngine,
  };
}

describe('SignalGenerator.generate — profitable opportunity', () => {
  it('generates signal when DEX sell price is above CEX ask by enough bps', async () => {
    // 100 bps DEX sell premium → buyCexSellDex spread ≈ 100 bps > minSpreadBps=50.
    const { generator } = makeGenerator(2000, 2001, { minSpreadBps: 50, minProfit: s(0.01), dexSellPremiumBps: 100 });
    const signal = await generator.generate('ETH/USDT');
    expect(signal).not.toBeNull();
    expect(signal!.expectedNetPnl).toBeGreaterThan(0n);
  });
});

describe('SignalGenerator.generate — no opportunity', () => {
  it('returns null when DEX spread is below minSpreadBps', async () => {
    // 5 bps DEX premium but minSpreadBps=200 → no signal.
    const { generator } = makeGenerator(2000, 2001, { minSpreadBps: 200, dexSellPremiumBps: 5 });
    const signal = await generator.generate('ETH/USDT');
    expect(signal).toBeNull();
  });
});

describe('SignalGenerator — cooldown', () => {
  it('second call within cooldown returns null even if spread is good', async () => {
    const { generator } = makeGenerator(2000, 2001, {
      minSpreadBps: 50,
      minProfit: s(0.01),
      dexSellPremiumBps: 100,
      cooldownMs: 60_000,
    });
    const first = await generator.generate('ETH/USDT');
    expect(first).not.toBeNull();
    const second = await generator.generate('ETH/USDT');
    expect(second).toBeNull();
  });
});

describe('SignalGenerator — direction selection', () => {
  it('picks BUY_CEX_SELL_DEX when DEX sell premium exceeds buy discount', async () => {
    // Sell premium 100 bps >> buy discount 10 bps → BUY_CEX_SELL_DEX wins.
    const { generator } = makeGenerator(2000, 2001, {
      minSpreadBps: 10,
      minProfit: s(0.001),
      dexSellPremiumBps: 100,
      dexBuyDiscountBps: 10,
    });
    const signal = await generator.generate('ETH/USDT');
    expect(signal?.direction).toBe(Direction.BUY_CEX_SELL_DEX);
  });
});
