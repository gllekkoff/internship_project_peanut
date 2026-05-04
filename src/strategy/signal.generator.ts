import { randomUUID } from 'crypto';
import { PRICE_SCALE } from '@/core/core.constants';
import { makeLogger } from '@/core/core.logger';
import type { Address, Token } from '@/core/core.types';
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
  private readonly tradeSizeUsd: bigint;
  private readonly minProfit: bigint;
  private readonly maxPosition: bigint;
  private readonly signalTtlMs: number;
  private readonly cooldownMs: number;
  private readonly pairTokens: Map<string, readonly [Token, Token]> | undefined;
  private readonly senderAddress: Address | undefined;
  private readonly swapGasUnits: bigint;
  private readonly poolAddress: string | undefined;
  private readonly lastSignalTime: Map<string, number> = new Map();
  private gasCache: { value: bigint; ts: number } | null = null;

  constructor(
    private readonly exchangeClient: ExchangeClient,
    private readonly pricingEngine: PricingEngine | null,
    private readonly inventory: InventoryTracker,
    private readonly fees: FeeCalculator,
    config: SignalGeneratorConfig = {},
    private readonly chainClient?: ChainClient,
  ) {
    this.minSpreadBps = config.minSpreadBps ?? 50;
    this.tradeSizeUsd = config.tradeSizeUsd ?? 18n * PRICE_SCALE;
    this.minProfit = config.minProfit ?? 5n * PRICE_SCALE;
    this.maxPosition = config.maxPosition ?? 10_000n * PRICE_SCALE;
    this.signalTtlMs = config.signalTtlMs ?? 5_000;
    this.cooldownMs = config.cooldownMs ?? 2_000;
    this.pairTokens = config.pairTokens;
    this.senderAddress = config.senderAddress;
    this.swapGasUnits = config.swapGasUnits ?? 150_000n;
    this.poolAddress = config.poolAddress;
  }

  /**
   * Attempts to generate a signal for the given pair.
   * Returns a Signal when an opportunity clears all fee and inventory checks, null otherwise.
   * Pass `book` to skip the REST order book fetch — used when called from a WebSocket depth handler.
   */
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

    // Float ratio — bigint division would truncate sub-integer spreads to zero on liquid pairs.
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
      return null;
    }

    const tradeValue = (size * cexPrice) / PRICE_SCALE;
    // Gross PnL from actual price difference — avoids round-tripping through the float spreadBps.
    const grossPnl =
      direction === Direction.BUY_CEX_SELL_DEX
        ? (size * (dexPrice - cexPrice)) / PRICE_SCALE
        : (size * (cexPrice - dexPrice)) / PRICE_SCALE;

    const liveGasCost = await this.fetchLiveGasCost(cexBid);
    const totalFee = this.fees.totalFee(tradeValue, liveGasCost);
    const netPnl = grossPnl - totalFee;

    if (netPnl < this.minProfit) return null;

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
      // Score = multiples of minimum profit; drives prioritisation when multiple signals are live.
      score: Number(netPnl) / Number(this.minProfit),
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

      // Derive size from the top-of-book ask before walking — no hardcoded price assumptions.
      const topAsk = ob.bestAsk[0];
      if (topAsk === 0n) return null;
      const size = (this.tradeSizeUsd * PRICE_SCALE) / topAsk;
      const sizeNum = Number(size) / Number(PRICE_SCALE);

      const analyzer = new OrderBookAnalyzer(ob);
      const bidWalk = analyzer.walkTheBook('sell', sizeNum);
      const askWalk = analyzer.walkTheBook('buy', sizeNum);

      // Not enough depth on either side to fill the full trade — skip signal.
      if (!bidWalk.fullyFilled || !askWalk.fullyFilled) return null;

      const cexBid = bidWalk.avgPrice;
      const cexAsk = askWalk.avgPrice;

      let dexBuyPrice: bigint;
      let dexSellPrice: bigint;

      const tokens = this.pairTokens?.get(pair);

      if (this.pricingEngine !== null && tokens !== undefined && this.senderAddress !== undefined) {
        const [baseToken, quoteToken] = tokens;

        // Sell: send base → receive quote. dexSellPrice = quoteReceived / baseIn (PRICE_SCALE).
        const baseAmountIn = (size * 10n ** BigInt(baseToken.decimals)) / PRICE_SCALE;
        const quoteReceived = this.pricingEngine.getAmmQuote(baseToken, quoteToken, baseAmountIn);
        const quoteReceivedScaled =
          (quoteReceived * PRICE_SCALE) / 10n ** BigInt(quoteToken.decimals);
        dexSellPrice = (quoteReceivedScaled * PRICE_SCALE) / size;

        // Buy: send quote → receive base. Approximate quoteIn from CEX bid.
        // dexBuyPrice = quoteIn / baseReceived (PRICE_SCALE).
        const quoteAmountScaled = (size * cexBid) / PRICE_SCALE;
        const quoteAmountIn =
          (quoteAmountScaled * 10n ** BigInt(quoteToken.decimals)) / PRICE_SCALE;
        const baseReceived = this.pricingEngine.getAmmQuote(quoteToken, baseToken, quoteAmountIn);
        const baseReceivedScaled = (baseReceived * PRICE_SCALE) / 10n ** BigInt(baseToken.decimals);
        dexBuyPrice =
          baseReceivedScaled > 0n ? (quoteAmountScaled * PRICE_SCALE) / baseReceivedScaled : 0n;
      } else {
        throw new Error(
          `No DEX pricing available for ${pair} — pricingEngine or token config missing`,
        );
      }

      return { cexBid, cexAsk, dexBuyPrice, dexSellPrice, size };
    } catch (e) {
      throw e instanceof Error ? e : new Error(`fetchPrices failed for ${pair}: ${String(e)}`);
    }
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

    const px = (v: bigint) => (Number(v) / s).toFixed(6);
    const bps = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}bps`;

    const cexMid = (cexBid + cexAsk) / 2n;
    const cexSpreadBps = cexMid > 0n ? (Number(cexAsk - cexBid) * 10_000) / Number(cexMid) : 0;

    const dexMid = (dexBuyPrice + dexSellPrice) / 2n;
    const dexSpreadBps =
      dexMid > 0n ? (Number(dexBuyPrice - dexSellPrice) * 10_000) / Number(dexMid) : 0;

    const pool = this.poolAddress ? `  pool=${this.poolAddress}` : '';
    const warn = dexSpreadBps > 500 ? '  [dex_spread_extremely_wide]' : '';

    log.info(
      `[NO_SIGNAL] ${pair}  size=${sizeNum.toFixed(4)} ${base}  thr=${this.minSpreadBps}bps\n` +
        `\tcex  bid=${px(cexBid)}  ask=${px(cexAsk)}  spread=${bps(cexSpreadBps)}\n` +
        `\tdex  sell=${px(dexSellPrice)}  buy=${px(dexBuyPrice)}  spread=${bps(dexSpreadBps)}\n` +
        `\t${pool}${warn}\n` +
        `\tB>D=${bps(buyCexSellDexBps)}  D>B=${bps(buyDexSellCexBps)}`,
    );
  }
}
