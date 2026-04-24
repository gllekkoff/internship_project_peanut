import { PRICE_SCALE, PRICE_SCALE_NUM } from '@/core/core.constants';
import type { ExchangeClient } from '@/exchange/cexClient/exchange.client';
import { OrderBookAnalyzer } from '@/exchange/orderBook/orderBook.analyzer';
import type { InventoryTracker } from '@/inventory/tracker/tracker.service';
import type { PnLEngine } from '@/inventory/pnl/pnl.service';
import type { PricingEngine } from '@/pricing/engine/engine.service';
import { UnknownPairError, PairConfigError } from './arbChecker.errors';
import type {
  ArbCheckResult,
  ArbCostDetails,
  ArbInventoryDetails,
  PairConfig,
} from './arbChecker.interfaces';

/**
 * End-to-end arbitrage check: detect opportunity → estimate costs → validate inventory.
 * Does NOT execute trades — identification only.
 */
export class ArbChecker {
  private readonly pairs: Map<string, PairConfig>;

  /** @param configs One entry per tradeable pair — keyed by pair string for O(1) lookup. */
  constructor(
    readonly pricingEngine: PricingEngine,
    readonly exchangeClient: ExchangeClient,
    readonly tracker: InventoryTracker,
    readonly pnl: PnLEngine,
    configs: PairConfig[],
  ) {
    this.pairs = new Map(configs.map((c) => [c.pair, c]));
  }

  /**
   * Full arb check for one pair: DEX price → CEX book → gap → costs → inventory.
   * Throws UnknownPairError if the pair was not registered at construction.
   */
  async check(pair: string): Promise<ArbCheckResult> {
    const cfg = this.pairs.get(pair);
    if (!cfg)
      throw new UnknownPairError(
        `Pair '${pair}' not configured — register it in ArbChecker constructor`,
      );

    const { pool, tradeSize, dexFeeBps, cexFeeBps, gasCostUsd, dexVenue, cexVenue } = cfg;
    const invBase = cfg.inventoryBaseAsset ?? cfg.baseAsset;
    const invQuote = cfg.inventoryQuoteAsset ?? cfg.quoteAsset;

    const baseToken =
      pool.token0.symbol === cfg.baseAsset
        ? pool.token0
        : pool.token1.symbol === cfg.baseAsset
          ? pool.token1
          : null;

    if (!baseToken) {
      throw new PairConfigError(
        `Pool ${pool.address.value} does not contain base asset '${cfg.baseAsset}'`,
      );
    }

    const quoteToken = baseToken === pool.token0 ? pool.token1 : pool.token0;

    // tradeSize is PRICE_SCALE units; convert to native token decimals for AMM math.
    const amountInNative = (tradeSize * 10n ** BigInt(baseToken.decimals)) / PRICE_SCALE;
    const quoteOutNative = pool.getAmountOut(amountInNative, baseToken);
    const dexPriceImpactBps = Number(pool.getPriceImpactBps(amountInNative, baseToken));

    // Convert output back to PRICE_SCALE, then compute effective price per unit of base.
    const quoteOutScaled = (quoteOutNative * PRICE_SCALE) / 10n ** BigInt(quoteToken.decimals);
    const dexPrice = (quoteOutScaled * PRICE_SCALE) / tradeSize;

    const orderBook = await this.exchangeClient.fetchOrderBook(cfg.cexSymbol, 20);
    const analyzer = new OrderBookAnalyzer(orderBook);

    const tradeSizeNum = Number(tradeSize) / PRICE_SCALE_NUM;
    const buyWalk = analyzer.walkTheBook('buy', tradeSizeNum);
    const sellWalk = analyzer.walkTheBook('sell', tradeSizeNum);

    const cexBid = orderBook.bestBid[0];
    const cexAsk = orderBook.bestAsk[0];

    // buy_dex_sell_cex: profitable when cexBid > dexPrice.
    // buy_cex_sell_dex: profitable when dexPrice > cexAsk.
    const gapBuyCex = dexPrice > 0n ? (Number(cexBid - dexPrice) / Number(dexPrice)) * 10_000 : 0;
    const gapBuyDex = cexAsk > 0n ? (Number(dexPrice - cexAsk) / Number(cexAsk)) * 10_000 : 0;

    let direction: ArbCheckResult['direction'] = null;
    let gapBps = 0;
    let cexSlippageBps = 0;

    if (gapBuyCex > 0 && gapBuyCex >= gapBuyDex) {
      direction = 'buy_dex_sell_cex';
      gapBps = gapBuyCex;
      cexSlippageBps = Number(sellWalk.slippageBps);
    } else if (gapBuyDex > 0) {
      direction = 'buy_cex_sell_dex';
      gapBps = gapBuyDex;
      cexSlippageBps = Number(buyWalk.slippageBps);
    }

    const midPriceUsd = Number(orderBook.midPrice) / PRICE_SCALE_NUM;
    const gasCostBps = midPriceUsd > 0 ? (gasCostUsd / (midPriceUsd * tradeSizeNum)) * 10_000 : 0;
    const totalCostBps = dexFeeBps + dexPriceImpactBps + cexFeeBps + cexSlippageBps + gasCostBps;

    const details: ArbCostDetails = {
      dexFeeBps,
      dexPriceImpactBps,
      cexFeeBps,
      cexSlippageBps,
      gasCostUsd,
      totalCostBps,
    };

    const estimatedNetPnlBps = gapBps - totalCostBps;

    // Venues flip with direction: quote is spent at the buy venue, base is sold at the other.
    const quoteNeeded = (tradeSize * dexPrice) / PRICE_SCALE;
    const quoteVenue = direction === 'buy_cex_sell_dex' ? cexVenue : dexVenue;
    const baseVenue = direction === 'buy_cex_sell_dex' ? dexVenue : cexVenue;

    const invCheck = this.tracker.canExecute(
      quoteVenue,
      invQuote,
      quoteNeeded,
      baseVenue,
      invBase,
      tradeSize,
    );

    const inventoryDetails: ArbInventoryDetails = {
      quoteVenue,
      quoteAsset: invQuote,
      quoteAvailable: invCheck.buyVenueAvailable,
      quoteNeeded: invCheck.buyVenueNeeded,
      baseVenue,
      baseAsset: invBase,
      baseAvailable: invCheck.sellVenueAvailable,
      baseNeeded: invCheck.sellVenueNeeded,
    };

    return {
      pair,
      timestamp: new Date(),
      dexPrice,
      cexBid,
      cexAsk,
      gapBps,
      direction,
      details,
      estimatedCostsBps: totalCostBps,
      estimatedNetPnlBps,
      inventoryOk: invCheck.canExecute,
      inventoryDetails,
      executable: invCheck.canExecute && estimatedNetPnlBps > 0,
    };
  }

  /** Runs check() for every configured pair concurrently and returns all results. */
  async checkAll(): Promise<ArbCheckResult[]> {
    return Promise.all([...this.pairs.keys()].map((p) => this.check(p)));
  }
}
