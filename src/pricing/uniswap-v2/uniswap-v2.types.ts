import type { Token, Address } from '@/core/core.types';

/** Raw reserves returned by getReserves(). */
export interface PairReserves {
  readonly reserve0: bigint;
  readonly reserve1: bigint;
  readonly blockTimestampLast: number;
}

/** Immutable snapshot of full pair state — address, tokens, reserves, fee. */
export interface UniswapV2PairState {
  readonly address: Address;
  readonly token0: Token;
  readonly token1: Token;
  readonly reserve0: bigint;
  readonly reserve1: bigint;
  /** Fee in basis points — standard Uniswap V2 is 30 bps (0.30%). */
  readonly feeBps: bigint;
}

/** All swap outputs in one structure — amounts, prices, and impact. */
export interface SwapResult {
  readonly amountOut: bigint;
  /** Spot price before the swap, scaled by 1e18. */
  readonly spotPriceBefore: bigint;
  /** Actual price paid for this trade, scaled by 1e18. */
  readonly executionPrice: bigint;
  /** Price impact in basis points (100 = 1.00%). */
  readonly priceImpactBps: bigint;
}

/** One row in the impact table — metrics for a single trade size. */
export interface ImpactRow {
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  /** Spot price before the swap, scaled by 1e18. */
  readonly spotPriceBefore: bigint;
  /** Actual price paid for this trade, scaled by 1e18. */
  readonly executionPrice: bigint;
  /** Price impact in basis points (100 = 1.00%). */
  readonly priceImpactBps: bigint;
}

/** Full cost breakdown including gas overhead expressed in output-token units. */
export interface TrueCostResult {
  /** Token output before deducting gas cost. */
  readonly grossOutput: bigint;
  /** Gas cost in ETH wei (gasPriceWei × gasEstimate). */
  readonly gasCostEth: bigint;
  /** Gas cost converted to output-token units using caller-supplied ETH price. */
  readonly gasCostInOutputToken: bigint;
  /** grossOutput minus gasCostInOutputToken, floored at 0. */
  readonly netOutput: bigint;
  /** netOutput / amountIn scaled by 1e18; 0 when trade is gas-negative. */
  readonly effectivePrice: bigint;
}
