import { randomUUID } from 'crypto';
import { PRICE_SCALE } from '@/core/core.constants';
import { makeLogger } from '@/core/core.logger';
import type { Token } from '@/core/core.types';
import type { ChainClient } from '@/chain/chain.client';
import type { ExchangeClient } from '@/exchange/cexClient/exchange.client';
import type { OrderBook } from '@/exchange/cexClient/exchange.interfaces';
import { OrderBookAnalyzer } from '@/exchange/orderBook/orderBook.analyzer';
import type { PricingEngine } from '@/pricing/engine/engine.service';
import type { InventoryTracker } from '@/inventory/tracker/tracker.service';
import { Venue } from '@/inventory/tracker/tracker.interfaces';
import type { FeeCalculator } from '@/strategy/fee.calculator';
import { Direction, Signal } from '@/strategy/signal.interfaces';
import type { SignalGeneratorConfig, PriceLevels } from '@/strategy/signal.interfaces';

const log = makeLogger('Signal');

/**
 * Generates validated arb signals by comparing live CEX and DEX prices against fee thresholds.
 * Does not execute trades — signal creation only.
 */
export class SignalGenerator {
  private readonly minSpreadBps: number;
  private readonly tradeSizeMin: bigint;
  private readonly tradeSizeMax: bigint;
  private readonly tradeSizeSteps: number;
  private readonly minProfit: bigint;
  private readonly maxPosition: bigint;
  private readonly signalTtlMs: number;
  private readonly cooldownMs: number;
  private readonly pairTokens: Map<string, readonly [Token, Token]> | undefined;
  private readonly swapGasUnits: bigint;
  private readonly lastSignalTime: Map<string, number> = new Map();
  private readonly lastLoggedPrices: Map<string, PriceLevels> = new Map();
  private gasCache: { value: bigint; ts: number } | null = null;

  // 0.000001 in human price = 100 units at PRICE_SCALE (1e8)
  private static readonly LOG_PRICE_TOLERANCE = 100n;

  constructor(
    private readonly exchangeClient: ExchangeClient,
    private readonly pricingEngine: PricingEngine | null,
    private readonly inventory: InventoryTracker,
    private readonly fees: FeeCalculator,
    config: SignalGeneratorConfig = {},
    private readonly chainClient?: ChainClient,
  ) {
    this.minSpreadBps = config.minSpreadBps ?? 50;
    const fixedSize = config.tradeSizeUsd ?? 18n * PRICE_SCALE;
    this.tradeSizeMin = config.tradeSizeMin ?? fixedSize;
    this.tradeSizeMax = config.tradeSizeMax ?? this.tradeSizeMin;
    this.tradeSizeSteps = config.tradeSizeSteps ?? 5;
    this.minProfit = config.minProfit ?? 5n * PRICE_SCALE;
    this.maxPosition = config.maxPosition ?? 10_000n * PRICE_SCALE;
    this.signalTtlMs = config.signalTtlMs ?? 5_000;
    this.cooldownMs = config.cooldownMs ?? 2_000;
    this.pairTokens = config.pairTokens;
    this.swapGasUnits = config.swapGasUnits ?? 150_000n;
  }

  async generate(pair: string, book?: OrderBook): Promise<Signal | null> {
    if (this.inCooldown(pair)) return null;
    const signal = await this.generateCore(pair, book);
    if (signal) this.lastSignalTime.set(pair, Date.now());
    return signal;
  }

  /**
   * Same as generate() but skips cooldown and does not update the cooldown timer.
   * Use for re-validating a signal immediately before execution without consuming a tick.
   */
  async peek(pair: string, book?: OrderBook): Promise<Signal | null> {
    return this.generateCore(pair, book);
  }

  private async generateCore(pair: string, book?: OrderBook): Promise<Signal | null> {
    const prices = await this.fetchPrices(pair, book);
    if (prices === null) return null;

    const { cexBid, cexAsk, dexBuyPrice, dexSellPrice, size } = prices;

    const buyCexSellDexBps =
      cexAsk > 0n ? (Number(dexSellPrice - cexAsk) * 10_000) / Number(cexAsk) : 0;
    const buyDexSellCexBps =
      dexBuyPrice > 0n ? (Number(cexBid - dexBuyPrice) * 10_000) / Number(dexBuyPrice) : 0;

    let direction: Direction;
    let spreadBps: number;
    let cexPrice: bigint;
    let dexPrice: bigint;

    if (buyCexSellDexBps > buyDexSellCexBps && buyCexSellDexBps >= this.minSpreadBps) {
      direction = Direction.BUY_CEX_SELL_DEX;
      spreadBps = buyCexSellDexBps;
      cexPrice = cexAsk;
      dexPrice = dexSellPrice;
    } else if (buyDexSellCexBps >= this.minSpreadBps) {
      direction = Direction.BUY_DEX_SELL_CEX;
      spreadBps = buyDexSellCexBps;
      cexPrice = cexBid;
      dexPrice = dexBuyPrice;
    } else {
      const current = { cexBid, cexAsk, dexBuyPrice, dexSellPrice, size };
      if (this.pricesChanged(pair, current)) {
        this.lastLoggedPrices.set(pair, current);
        this.logNoSignal(
          pair,
          cexBid,
          cexAsk,
          dexBuyPrice,
          dexSellPrice,
          size,
          buyCexSellDexBps,
          buyDexSellCexBps,
        );
      }
      return null;
    }

    const tradeValue = (size * cexPrice) / PRICE_SCALE;
    const grossPnl =
      direction === Direction.BUY_CEX_SELL_DEX
        ? (size * (dexPrice - cexPrice)) / PRICE_SCALE
        : (size * (cexPrice - dexPrice)) / PRICE_SCALE;

    const liveGasCost = await this.fetchLiveGasCost(cexBid);
    const totalFee = this.fees.totalFee(tradeValue, liveGasCost);
    const netPnl = grossPnl - totalFee;

    if (netPnl < this.minProfit) {
      const current = { cexBid, cexAsk, dexBuyPrice, dexSellPrice, size };
      if (this.pricesChanged(pair, current)) {
        this.lastLoggedPrices.set(pair, current);
        const s = Number(PRICE_SCALE);
        const fmt = (v: bigint) => `$${(Number(v) / s).toFixed(4)}`;
        log.info(
          `[UNPROFITABLE] ${pair}  ${direction}  spread=${spreadBps.toFixed(2)}bps` +
            `  gross=${fmt(grossPnl)}  fees=${fmt(totalFee)}  net=${fmt(netPnl)}`,
        );
      }
      return null;
    }

    const [base, quote] = pair.split('/') as [string, string];
    const inventoryOk = this.checkInventory(direction, base, quote, size, cexPrice);
    const withinLimits = tradeValue <= this.maxPosition;

    const pairSlug = pair.replace('/', '');
    const signalId = `${pairSlug}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const now = new Date();

    const signal = new Signal({
      signalId,
      pair,
      direction,
      cexPrice,
      dexPrice,
      spreadBps,
      size,
      expectedGrossPnl: grossPnl,
      expectedFees: totalFee,
      expectedNetPnl: netPnl,
      score:
        this.minProfit > 0n
          ? Number(netPnl) / Number(this.minProfit)
          : Number(netPnl) / Number(PRICE_SCALE),
      timestamp: now,
      expiry: new Date(now.getTime() + this.signalTtlMs),
      inventoryOk,
      withinLimits,
    });

    return signal;
  }

  /** True when the pair is still within its post-signal cooldown window. */
  private inCooldown(pair: string): boolean {
    return Date.now() - (this.lastSignalTime.get(pair) ?? 0) < this.cooldownMs;
  }

  /** Cached for 30 s — falls back to null so FeeCalculator uses its static gasCost. */
  private async fetchLiveGasCost(ethPriceUsd: bigint): Promise<bigint | null> {
    if (!this.chainClient || ethPriceUsd === 0n) return null;
    const GAS_CACHE_TTL_MS = 30_000;
    if (this.gasCache && Date.now() - this.gasCache.ts < GAS_CACHE_TTL_MS) {
      return (this.gasCache.value * ethPriceUsd) / 10n ** 18n;
    }
    try {
      const gasPrice = await this.chainClient.getGasPrice();
      const maxFeeWei = gasPrice.getMaxFee('medium');
      const gasCostWei = maxFeeWei * this.swapGasUnits;
      this.gasCache = { value: gasCostWei, ts: Date.now() };
      return (gasCostWei * ethPriceUsd) / 10n ** 18n;
    } catch (e) {
      log.warn(`Gas price fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** Uses `book` directly when provided (WebSocket path), otherwise fetches via REST. */
  private async fetchPrices(pair: string, book?: OrderBook): Promise<PriceLevels | null> {
    try {
      const ob = book ?? (await this.exchangeClient.fetchOrderBook(pair, 5));
      const topAsk = ob.bestAsk[0];
      if (topAsk === 0n) return null;

      const tokens = this.pairTokens?.get(pair);
      if (this.pricingEngine === null || tokens === undefined) {
        throw new Error(
          `No DEX pricing available for ${pair} — pricingEngine or token config missing`,
        );
      }

      return this.findBestPrices(ob, topAsk, tokens);
    } catch (e) {
      throw e instanceof Error ? e : new Error(`fetchPrices failed for ${pair}: ${String(e)}`);
    }
  }

  /** Returns N evenly-spaced USD trade sizes (at PRICE_SCALE) across [tradeSizeMin, tradeSizeMax]. */
  private candidateSizes(): bigint[] {
    if (this.tradeSizeMin === this.tradeSizeMax) return [this.tradeSizeMin];
    const steps = Math.max(2, this.tradeSizeSteps);
    const range = this.tradeSizeMax - this.tradeSizeMin;
    return Array.from(
      { length: steps },
      (_, i) => this.tradeSizeMin + (range * BigInt(i)) / BigInt(steps - 1),
    );
  }

  /** Pure sync: walks the CEX order book and queries the AMM for a given USD trade size. */
  private computePricesAt(
    ob: OrderBook,
    sizeUsd: bigint,
    topAsk: bigint,
    tokens: readonly [Token, Token],
  ): PriceLevels | null {
    const size = (sizeUsd * PRICE_SCALE) / topAsk;
    const sizeNum = Number(size) / Number(PRICE_SCALE);

    const analyzer = new OrderBookAnalyzer(ob);
    const bidWalk = analyzer.walkTheBook('sell', sizeNum);
    const askWalk = analyzer.walkTheBook('buy', sizeNum);
    if (!bidWalk.fullyFilled || !askWalk.fullyFilled) return null;

    const cexBid = bidWalk.avgPrice;
    const cexAsk = askWalk.avgPrice;
    const [baseToken, quoteToken] = tokens;

    const baseAmountIn = (size * 10n ** BigInt(baseToken.decimals)) / PRICE_SCALE;
    const quoteReceived = this.pricingEngine!.getAmmQuote(baseToken, quoteToken, baseAmountIn);
    const quoteReceivedScaled = (quoteReceived * PRICE_SCALE) / 10n ** BigInt(quoteToken.decimals);
    const dexSellPrice = size > 0n ? (quoteReceivedScaled * PRICE_SCALE) / size : 0n;

    const quoteAmountScaled = (size * cexBid) / PRICE_SCALE;
    const quoteAmountIn = (quoteAmountScaled * 10n ** BigInt(quoteToken.decimals)) / PRICE_SCALE;
    const baseReceived = this.pricingEngine!.getAmmQuote(quoteToken, baseToken, quoteAmountIn);
    const baseReceivedScaled = (baseReceived * PRICE_SCALE) / 10n ** BigInt(baseToken.decimals);
    const dexBuyPrice =
      baseReceivedScaled > 0n ? (quoteAmountScaled * PRICE_SCALE) / baseReceivedScaled : 0n;

    return { cexBid, cexAsk, dexBuyPrice, dexSellPrice, size };
  }

  /** Static fee estimate (no gas fetch) used only for comparing candidate sizes in the sweep. */
  private estimateNetPnl(prices: PriceLevels): bigint {
    const { cexBid, cexAsk, dexBuyPrice, dexSellPrice, size } = prices;
    const buyCexGross =
      dexSellPrice > cexAsk ? (size * (dexSellPrice - cexAsk)) / PRICE_SCALE : -1n;
    const buyDexGross = cexBid > dexBuyPrice ? (size * (cexBid - dexBuyPrice)) / PRICE_SCALE : -1n;
    const grossPnl = buyCexGross > buyDexGross ? buyCexGross : buyDexGross;
    if (grossPnl <= 0n) return -1n;
    const tradeValue = (size * cexAsk) / PRICE_SCALE;
    return grossPnl - this.fees.totalFee(tradeValue);
  }

  /** Sweeps all candidate USD sizes and returns the PriceLevels with the highest estimated net PnL. */
  private findBestPrices(
    ob: OrderBook,
    topAsk: bigint,
    tokens: readonly [Token, Token],
  ): PriceLevels | null {
    let best: PriceLevels | null = null;
    let bestPnl = 0n;

    for (const sizeUsd of this.candidateSizes()) {
      const prices = this.computePricesAt(ob, sizeUsd, topAsk, tokens);
      if (prices === null) continue;
      const pnl = this.estimateNetPnl(prices);
      if (best === null || pnl > bestPnl) {
        bestPnl = pnl;
        best = prices;
      }
    }

    return best;
  }

  /**
   * Checks that pre-positioned inventory covers both legs.
   * BUY_CEX_SELL_DEX: needs quote at BINANCE (to buy) + base at WALLET (to sell on DEX).
   * BUY_DEX_SELL_CEX: needs quote at WALLET (to buy on DEX) + base at BINANCE (to sell).
   * A 1% buffer is applied to the quote requirement for rounding and slippage.
   */
  private checkInventory(
    direction: Direction,
    base: string,
    quote: string,
    size: bigint,
    cexPrice: bigint,
  ): boolean {
    const quoteNeeded = (size * cexPrice * 101n) / (PRICE_SCALE * 100n);

    if (direction === Direction.BUY_CEX_SELL_DEX) {
      return (
        this.inventory.getAvailable(Venue.BINANCE, quote) >= quoteNeeded &&
        this.inventory.getAvailable(Venue.WALLET, base) >= size
      );
    } else {
      return (
        this.inventory.getAvailable(Venue.WALLET, quote) >= quoteNeeded &&
        this.inventory.getAvailable(Venue.BINANCE, base) >= size
      );
    }
  }

  private pricesChanged(pair: string, current: PriceLevels): boolean {
    const prev = this.lastLoggedPrices.get(pair);
    if (!prev) return true;
    const t = SignalGenerator.LOG_PRICE_TOLERANCE;
    const diff = (a: bigint, b: bigint) => (a > b ? a - b : b - a);
    return (
      diff(current.cexBid, prev.cexBid) > t ||
      diff(current.cexAsk, prev.cexAsk) > t ||
      diff(current.dexBuyPrice, prev.dexBuyPrice) > t ||
      diff(current.dexSellPrice, prev.dexSellPrice) > t
    );
  }

  private logNoSignal(
    pair: string,
    cexBid: bigint,
    cexAsk: bigint,
    dexBuyPrice: bigint,
    dexSellPrice: bigint,
    size: bigint,
    buyCexSellDexBps: number,
    buyDexSellCexBps: number,
  ): void {
    const s = Number(PRICE_SCALE);
    const [base = ''] = pair.split('/');
    const sizeNum = Number(size) / s;

    const isBuyCex = buyCexSellDexBps >= buyDexSellCexBps;
    const bestBps = isBuyCex ? buyCexSellDexBps : buyDexSellCexBps;
    const bestDir = isBuyCex ? 'buyCexSellDex' : 'buyDexSellCex';

    const refPrice = isBuyCex ? cexAsk : cexBid;
    const tradeValue = (size * refPrice) / PRICE_SCALE;
    const grossPnl = isBuyCex
      ? (size * (dexSellPrice - cexAsk)) / PRICE_SCALE
      : (size * (cexBid - dexBuyPrice)) / PRICE_SCALE;
    const approxNet = grossPnl - this.fees.totalFee(tradeValue);

    const px = (v: bigint) => (Number(v) / s).toFixed(6);
    const bps = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}bps`;
    const fmt$ = (v: bigint) =>
      `${v >= 0n ? '+' : '-'}$${(Number(v < 0n ? -v : v) / s).toFixed(3)}`;

    const dexMid = (dexBuyPrice + dexSellPrice) / 2n;
    const warn =
      dexMid > 0n && (Number(dexBuyPrice - dexSellPrice) * 10_000) / Number(dexMid) > 500
        ? '  [dex_spread_extremely_wide]'
        : '';

    log.info(
      `[NO_SIGNAL] ${pair}  ${sizeNum.toFixed(4)} ${base}  arb=${bps(bestBps)} (${bestDir})  net≈${fmt$(approxNet)}  thr=${this.minSpreadBps}bps${warn}\n` +
        `\t\t\t\t\tcex  bid=${px(cexBid)}  ask=${px(cexAsk)}  |  dex  sell=${px(dexSellPrice)}  buy=${px(dexBuyPrice)}`,
    );
  }
}
