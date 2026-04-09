import type { Address } from '@/core/core.types';

/** Maps a 4-byte selector to its DEX name and function name. */
export interface SwapSelector {
  readonly dex: string;
  readonly method: string;
}

/**
 * Normalised parameters extracted from swap calldata.
 * All variants (exact-in, exact-out, ETH-in, ETH-out) are mapped to the same shape:
 *   amountIn    — exact input (exact-in) or maximum input (exact-out); 0n for native ETH input
 *   amountOutMin — minimum output (exact-in) or exact output (exact-out)
 */
export interface DecodedSwapParams {
  /** 0n when the input is native ETH — service fills this from tx.value. */
  readonly amountIn: bigint;
  readonly amountOutMin: bigint;
  readonly path: readonly `0x${string}`[];
  readonly tokenIn: Address | null;
  readonly tokenOut: Address | null;
  readonly deadline: bigint;
  readonly isExactIn: boolean;
}
