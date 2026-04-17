import type { UniswapV2Pair } from '@/pricing/uniswap-v2/uniswap-v2.service';
import { Venue } from '@/inventory/tracker/tracker.interfaces';

/** Per-pair configuration wiring the DEX pool to its CEX counterpart. */
export interface PairConfig {
  /** Human-readable pair string, e.g. 'ETH/USDT'. Used as the map key for check(). */
  readonly pair: string;
  /** Pool token symbol used for AMM math, e.g. 'WETH'. May differ from CEX symbol. */
  readonly baseAsset: string;
  /** Pool token symbol used for AMM math, e.g. 'USDC'. May differ from CEX symbol. */
  readonly quoteAsset: string;
  readonly cexSymbol: string;
  /** Tracker asset key for the base — defaults to baseAsset when omitted. */
  readonly inventoryBaseAsset?: string;
  /** Tracker asset key for the quote — defaults to quoteAsset when omitted. */
  readonly inventoryQuoteAsset?: string;
  readonly pool: UniswapV2Pair;
  /** Trade size in base asset, scaled by PRICE_SCALE. */
  readonly tradeSize: bigint;
  /** DEX fee in basis points (30 for Uniswap V2). */
  readonly dexFeeBps: number;
  readonly cexFeeBps: number;
  readonly gasCostUsd: number;
  /** Venue where DEX-side assets are held (e.g. Venue.WALLET for on-chain swaps). */
  readonly dexVenue: Venue;
  /** Venue where CEX-side assets are held (e.g. Venue.BINANCE). */
  readonly cexVenue: Venue;
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

/** Per-leg inventory snapshot included in every check result. */
export interface ArbInventoryDetails {
  readonly quoteVenue: Venue;
  readonly quoteAsset: string;
  readonly quoteAvailable: bigint;
  readonly quoteNeeded: bigint;
  readonly baseVenue: Venue;
  readonly baseAsset: string;
  readonly baseAvailable: bigint;
  readonly baseNeeded: bigint;
}

/** Full result of a single arb opportunity check. */
export interface ArbCheckResult {
  readonly pair: string;
  readonly timestamp: Date;
  /** DEX effective price (quoteOut / baseIn), scaled by PRICE_SCALE. */
  readonly dexPrice: bigint;
  /** CEX best bid, scaled by PRICE_SCALE. */
  readonly cexBid: bigint;
  /** CEX best ask, scaled by PRICE_SCALE. */
  readonly cexAsk: bigint;
  readonly gapBps: number;
  readonly direction: 'buy_dex_sell_cex' | 'buy_cex_sell_dex' | null;
  readonly details: ArbCostDetails;
  readonly estimatedCostsBps: number;
  readonly estimatedNetPnlBps: number;
  readonly inventoryOk: boolean;
  readonly inventoryDetails: ArbInventoryDetails;
  /** true when gap > costs AND inventory is sufficient. */
  readonly executable: boolean;
}
