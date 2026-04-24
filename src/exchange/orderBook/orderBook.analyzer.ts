import { PRICE_SCALE } from '@/core/core.constants';
import type { OrderBook } from '../cexClient/exchange.interfaces';
import type { Fill, WalkResult } from './orderBook.interfaces';

/** Analyses a single order book snapshot for fill simulation, depth, and imbalance. */
export class OrderBookAnalyzer {
  private readonly book: OrderBook;

  /** Accepts a snapshot from ExchangeClient.fetchOrderBook(). */
  constructor(book: OrderBook) {
    this.book = book;
  }

  /**
   * Simulates filling `qty` base asset against the book.
   * side='buy' walks asks (you pay ask prices); side='sell' walks bids (you receive bid prices).
   * If the book lacks sufficient liquidity, fullyFilled=false and fills cover what IS available.
   */
  walkTheBook(side: 'buy' | 'sell', qty: number): WalkResult {
    const levels = side === 'buy' ? this.book.asks : this.book.bids;
    const bestPrice = side === 'buy' ? this.book.bestAsk[0] : this.book.bestBid[0];

    let remaining = BigInt(Math.round(qty * Number(PRICE_SCALE)));
    let totalCost = 0n;
    const fills: Fill[] = [];

    for (const [price, levelQty] of levels) {
      if (remaining <= 0n) break;
      const filled = remaining < levelQty ? remaining : levelQty;
      // cost = qty × price; divide by PRICE_SCALE to keep result in quote units at PRICE_SCALE.
      const cost = (filled * price) / PRICE_SCALE;
      fills.push({ price, qty: filled, cost });
      totalCost += cost;
      remaining -= filled;
    }

    const totalFilled = BigInt(Math.round(qty * Number(PRICE_SCALE))) - remaining;
    const avgPrice = totalFilled > 0n ? (totalCost * PRICE_SCALE) / totalFilled : 0n;

    // Slippage: how far avgPrice moved from the best quoted price.
    let slippageBps = 0n;
    if (bestPrice > 0n && avgPrice > 0n) {
      slippageBps =
        side === 'buy'
          ? ((avgPrice - bestPrice) * 10_000n) / bestPrice
          : ((bestPrice - avgPrice) * 10_000n) / bestPrice;
      if (slippageBps < 0n) slippageBps = 0n;
    }

    return {
      avgPrice,
      totalCost,
      slippageBps,
      levelsConsumed: fills.length,
      fullyFilled: remaining <= 0n,
      fills,
    };
  }

  /**
   * Total base asset quantity available within `bps` basis points of the best price on that side.
   * Stops early once levels move outside the threshold — levels are sorted best-first.
   */
  depthAtBps(side: 'bid' | 'ask', bps: number): bigint {
    const levels = side === 'bid' ? this.book.bids : this.book.asks;
    const bestPrice = side === 'bid' ? this.book.bestBid[0] : this.book.bestAsk[0];
    const bpsBigint = BigInt(Math.round(bps));

    let total = 0n;
    for (const [price, qty] of levels) {
      // Compare without float: multiply both sides by 10_000 to avoid division.
      const inRange =
        side === 'bid'
          ? price * 10_000n >= bestPrice * (10_000n - bpsBigint)
          : price * 10_000n <= bestPrice * (10_000n + bpsBigint);

      if (!inRange) break; // levels are sorted — safe to stop once outside range
      total += qty;
    }

    return total;
  }

  /**
   * Order book imbalance over the top `levels` price levels.
   * Returns a float in [-1.0, +1.0]:
   *   +1.0 = all bids (strong buy pressure)
   *   -1.0 = all asks (strong sell pressure)
   *    0.0 = balanced
   */
  imbalance(levels: number = 10): number {
    const bids = this.book.bids.slice(0, levels);
    const asks = this.book.asks.slice(0, levels);

    const bidQty = bids.reduce((sum, [, qty]) => sum + qty, 0n);
    const askQty = asks.reduce((sum, [, qty]) => sum + qty, 0n);

    const total = bidQty + askQty;
    if (total === 0n) return 0;

    // Dimensionless ratio — convert to number for the final division.
    return Number(bidQty - askQty) / Number(total);
  }

  /**
   * True cost of immediacy for a round-trip of size `qty`, in basis points.
   * = (avg ask fill price − avg bid fill price) / mid price × 10000
   * Unlike quoted spread (best bid/ask only), this reflects real slippage at your trade size.
   */
  effectiveSpread(qty: number): bigint {
    if (this.book.midPrice === 0n) return 0n;
    const buyWalk = this.walkTheBook('buy', qty);
    const sellWalk = this.walkTheBook('sell', qty);
    if (buyWalk.avgPrice === 0n || sellWalk.avgPrice === 0n) return 0n;
    return ((buyWalk.avgPrice - sellWalk.avgPrice) * 10_000n) / this.book.midPrice;
  }
}
