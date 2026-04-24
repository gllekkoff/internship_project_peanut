import { randomUUID } from 'crypto';
import { PRICE_SCALE } from '@/core/core.constants';
import type { Address, Token } from '@/core/core.types';
import type { ChainClient } from '@/chain/chain.client';
import type { ExchangeClient } from '@/exchange/cexClient/exchange.client';
import type { PricingEngine } from '@/pricing/engine/engine.service';
import type { InventoryTracker } from '@/inventory/tracker/tracker.service';
import { Venue } from '@/inventory/tracker/tracker.interfaces';
import type { FeeCalculator } from '@/strategy/fee.calculator';
import { GasPriceFetchError } from '@/strategy/signal.errors';
import { Direction, Signal } from '@/strategy/signal.interfaces';
import type { SignalGeneratorConfig, PriceLevels } from '@/strategy/signal.interfaces';

// Estimated gas units for a single Uniswap V2 swap (base + 1 hop).
const SWAP_GAS_UNITS = 150_000n;

/**
 * Generates validated arb signals by comparing live CEX and DEX prices against fee thresholds.
 * Does not execute trades — signal creation only.
 */
export class SignalGenerator {
  private readonly minSpreadBps: number;
  private readonly minProfit: bigint;
  private readonly maxPosition: bigint;
  private readonly signalTtlMs: number;
  private readonly cooldownMs: number;
  private readonly pairTokens: Map<string, readonly [Token, Token]> | undefined;
  private readonly senderAddress: Address | undefined;
  private readonly lastSignalTime: Map<string, number> = new Map();

  constructor(
    private readonly exchangeClient: ExchangeClient,
    private readonly pricingEngine: PricingEngine | null,
    private readonly inventory: InventoryTracker,
    private readonly fees: FeeCalculator,
    config: SignalGeneratorConfig = {},
    private readonly chainClient?: ChainClient,
  ) {
    this.minSpreadBps = config.minSpreadBps ?? 50;
    this.minProfit = config.minProfit ?? 5n * PRICE_SCALE;
    this.maxPosition = config.maxPosition ?? 10_000n * PRICE_SCALE;
    this.signalTtlMs = config.signalTtlMs ?? 5_000;
    this.cooldownMs = config.cooldownMs ?? 2_000;
    this.pairTokens = config.pairTokens;
    this.senderAddress = config.senderAddress;
  }

  /**
   * Attempts to generate a signal for the given pair and size.
   * Returns a Signal when an opportunity clears all fee and inventory checks, null otherwise.
   * `size` is the base asset trade amount scaled by PRICE_SCALE (e.g. 1_00_000_000n = 1.0).
   */
  async generate(pair: string, size: bigint): Promise<Signal | null> {
    if (this.inCooldown(pair)) return null;

    const prices = await this.fetchPrices(pair, size);
    if (prices === null) return null;

    const { cexBid, cexAsk, dexBuyPrice, dexSellPrice } = prices;

    // Spread in bps as a float ratio — bigint division would truncate sub-integer spreads.
    // spread_a: buy on CEX (pay ask), sell on DEX — profitable when dexSell > cexAsk.
    const spreadABps = cexAsk > 0n ? (Number(dexSellPrice - cexAsk) * 10_000) / Number(cexAsk) : 0;
    // spread_b: buy on DEX (pay dexBuy), sell on CEX (receive bid) — profitable when cexBid > dexBuy.
    const spreadBBps =
      dexBuyPrice > 0n ? (Number(cexBid - dexBuyPrice) * 10_000) / Number(dexBuyPrice) : 0;

    let direction: Direction;
    let spreadBps: number;
    let cexPrice: bigint;
    let dexPrice: bigint;

    if (spreadABps > spreadBBps && spreadABps >= this.minSpreadBps) {
      direction = Direction.BUY_CEX_SELL_DEX;
      spreadBps = spreadABps;
      cexPrice = cexAsk;
      dexPrice = dexSellPrice;
    } else if (spreadBBps >= this.minSpreadBps) {
      direction = Direction.BUY_DEX_SELL_CEX;
      spreadBps = spreadBBps;
      cexPrice = cexBid;
      dexPrice = dexBuyPrice;
    } else {
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

    this.lastSignalTime.set(pair, Date.now());
    return signal;
  }

  /** True when the pair is still within its post-signal cooldown window. */
  private inCooldown(pair: string): boolean {
    return Date.now() - (this.lastSignalTime.get(pair) ?? 0) < this.cooldownMs;
  }

  /**
   * Fetches live gas price from chain and converts it to a USD gas cost estimate.
   * Uses the CEX ETH bid price to convert ETH gas cost to USD.
   * Falls back to null (caller uses FeeCalculator static gasCost) on any error.
   */
  private async fetchLiveGasCost(ethPriceUsd: bigint): Promise<bigint | null> {
    if (!this.chainClient || ethPriceUsd === 0n) return null;
    try {
      const gasPrice = await this.chainClient.getGasPrice();
      // maxFee in wei (base + medium priority)
      const maxFeeWei = gasPrice.getMaxFee('medium');
      // gasCostWei = maxFeePerGas × estimatedGasUnits
      const gasCostWei = maxFeeWei * SWAP_GAS_UNITS;
      // Convert wei → ETH (18 decimals) → USD (PRICE_SCALE)
      // gasCostUsd = gasCostWei * ethPriceUsd / 1e18
      return (gasCostWei * ethPriceUsd) / (10n ** 18n * PRICE_SCALE);
    } catch (e) {
      console.warn(
        `[SignalGenerator] gas price fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      new GasPriceFetchError(e instanceof Error ? e.message : String(e)); // surfaced for observability
      return null;
    }
  }

  /**
   * Fetches CEX order book and DEX prices.
   * Uses PricingEngine.getAmmQuote (pool math only, no fork simulation) when pairTokens
   * + senderAddress are configured; falls back to a random mid-price stub otherwise.
   */
  private async fetchPrices(pair: string, size: bigint): Promise<PriceLevels | null> {
    try {
      const ob = await this.exchangeClient.fetchOrderBook(pair, 5);
      const cexBid = ob.bestBid[0];
      const cexAsk = ob.bestAsk[0];

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
        // STUB: randomised DEX prices to simulate varying spread conditions for demo/testing.
        // sellPremiumBps: 0–150 bps above mid  → sometimes profitable, sometimes not.
        // buyDiscountBps: 0–80 bps below mid   → occasional buy-side opportunity.
        const mid = (cexBid + cexAsk) / 2n;
        const sellPremiumBps = BigInt(Math.floor(Math.random() * 151)); // 0–150 bps
        const buyDiscountBps = BigInt(Math.floor(Math.random() * 81)); // 0–80 bps
        dexSellPrice = (mid * (10_000n + sellPremiumBps)) / 10_000n;
        dexBuyPrice = (mid * (10_000n - buyDiscountBps)) / 10_000n;
        const fmt = (v: bigint) => `$${(Number(v) / Number(PRICE_SCALE)).toFixed(2)}`;
        console.log(
          `[SignalGenerator] DEX sim: sell=${fmt(dexSellPrice)} (+${sellPremiumBps}bps)` +
            ` buy=${fmt(dexBuyPrice)} (-${buyDiscountBps}bps)` +
            ` mid=${fmt(mid)}`,
        );
      }

      return { cexBid, cexAsk, dexBuyPrice, dexSellPrice };
    } catch {
      return null;
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
}
