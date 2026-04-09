import type { Token, Address } from '../../core/core.types.js';

// ---------------------------------------------------------------------------
// Raw on-chain reserves as returned by getReserves()
// ---------------------------------------------------------------------------

export interface PairReserves {
  readonly reserve0: bigint;
  readonly reserve1: bigint;
  readonly blockTimestampLast: number;
}

// ---------------------------------------------------------------------------
// Immutable snapshot of a Uniswap V2 pair state
// ---------------------------------------------------------------------------

export interface UniswapV2PairState {
  readonly address: Address;
  readonly token0: Token;
  readonly token1: Token;
  readonly reserve0: bigint;
  readonly reserve1: bigint;
  /**
   * Fee expressed in basis points.
   * Standard Uniswap V2 fee is 30 bps (0.30%).
   */
  readonly feeBps: bigint;
}

// ---------------------------------------------------------------------------
// Result of a simulated swap — carries all values in a single structure
// ---------------------------------------------------------------------------

export interface SwapResult {
  /** Amount of output token received */
  readonly amountOut: bigint;
  /** Spot price before the swap */
  readonly spotPriceBefore: bigint;
  /** Execution price of this specific trade */
  readonly executionPrice: bigint;
  /**
   * Price impact as a fraction e.g. 100 = 1.00%, 10000 = 100.00%.
   * Represented as basis points (bps) to avoid floats.
   */
  readonly priceImpactBps: bigint;
}

// ---------------------------------------------------------------------------
// PriceImpactAnalyzer output types
// ---------------------------------------------------------------------------

/** One row of the impact table — all values for a single trade size. */
export interface ImpactRow {
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  /** Spot price before the swap, scaled to 18 decimals */
  readonly spotPriceBefore: bigint;
  /** Execution price of this specific trade, scaled to 18 decimals */
  readonly executionPrice: bigint;
  /** Price impact in basis points (100 = 1.00%) */
  readonly priceImpactBps: bigint;
}

/**
 * Total cost estimate including gas overhead.
 *
 * All token amounts are in raw units (bigint).
 * All prices are scaled to 18 decimals (divide by 1e18 to get human price).
 */
export interface TrueCostResult {
  /** Raw output before deducting gas cost */
  readonly grossOutput: bigint;
  /** Gas cost expressed in ETH wei (gasPriceWei * gasEstimate) */
  readonly gasCostEth: bigint;
  /**
   * Gas cost converted to output-token units.
   * Accurate when one side of the pair is WETH; otherwise an approximation
   * based on the caller-supplied ethPriceInOutputToken.
   */
  readonly gasCostInOutputToken: bigint;
  /** grossOutput minus gasCostInOutputToken (floored at 0) */
  readonly netOutput: bigint;
  /**
   * Effective execution price after gas: netOutput / amountIn, scaled to 18 decimals.
   * 0 when the trade is gas-negative (gasCostInOutputToken > grossOutput).
   */
  readonly effectivePrice: bigint;
}
