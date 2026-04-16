import type { UniswapV2Pair } from '@/pricing/uniswap-v2/uniswap-v2.service';
import type { Venue } from '@/inventory/tracker/tracker.interfaces';

/** Per-pair configuration wiring the DEX pool to its CEX counterpart. */
export interface PairConfig {
  /** Human-readable pair string, e.g. 'ETH/USDT'. Used as the map key for check(). */
  readonly pair: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  /** CEX symbol, e.g. 'ETH/USDT'. */
  readonly cexSymbol: string;
  /** DEX pool — used for AMM price and price-impact math. */
  readonly pool: UniswapV2Pair;
  /** Trade size in base asset, scaled by PRICE_SCALE. */
  readonly tradeSize: bigint;
  /** DEX fee in basis points (30 for Uniswap V2). */
  readonly dexFeeBps: number;
  /** CEX taker fee in basis points. */
  readonly cexFeeBps: number;
  /** Gas cost per arb round-trip in USD. */
  readonly gasCostUsd: number;
  /** Venue holding the base asset for the sell-on-CEX direction. */
  readonly baseVenue: Venue;
  /** Venue holding the quote asset for the buy-on-DEX direction. */
  readonly quoteVenue: Venue;
}

/** Breakdown of all costs that eat into the gross price gap. All values in basis points. */
export interface ArbCostDetails {
  readonly dexFeeBps: number;
  readonly dexPriceImpactBps: number;
  readonly cexFeeBps: number;
  readonly cexSlippageBps: number;
  readonly gasCostUsd: number;
  readonly totalCostBps: number;
}

/** Full result of a single arb opportunity check. */
export interface ArbCheckResult {
  readonly pair: string;
  readonly timestamp: Date;
  /** DEX effective price (amountOut / amountIn), scaled by PRICE_SCALE. */
  readonly dexPrice: bigint;
  /** CEX best bid, scaled by PRICE_SCALE. */
  readonly cexBid: bigint;
  /** CEX best ask, scaled by PRICE_SCALE. */
  readonly cexAsk: bigint;
  /** Gross price gap in basis points. */
  readonly gapBps: number;
  readonly direction: 'buy_dex_sell_cex' | 'buy_cex_sell_dex' | null;
  readonly details: ArbCostDetails;
  readonly estimatedCostsBps: number;
  readonly estimatedNetPnlBps: number;
  readonly inventoryOk: boolean;
  /** true when gap > costs AND inventory is available. */
  readonly executable: boolean;
}
