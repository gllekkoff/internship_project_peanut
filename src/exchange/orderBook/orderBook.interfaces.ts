/** A single filled level during a walk-the-book simulation. All values scaled by PRICE_SCALE. */
export interface Fill {
  readonly price: bigint;
  readonly qty: bigint;
  readonly cost: bigint;
}

/** Result of walking the order book to fill a given quantity. All monetary values scaled by PRICE_SCALE. */
export interface WalkResult {
  /** Volume-weighted average fill price, scaled by PRICE_SCALE. */
  readonly avgPrice: bigint;
  /** Total quote currency spent/received, scaled by PRICE_SCALE. */
  readonly totalCost: bigint;
  /** Slippage vs best price, in basis points (unscaled). */
  readonly slippageBps: bigint;
  /** Number of price levels consumed to fill the order. */
  readonly levelsConsumed: number;
  /** False when the book did not have enough liquidity to fill the full qty. */
  readonly fullyFilled: boolean;
  /** Breakdown of fills per level. */
  readonly fills: readonly Fill[];
}
