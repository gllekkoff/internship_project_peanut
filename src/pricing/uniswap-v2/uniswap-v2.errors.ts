import { AppError } from '@/core/core.errors';

/** Thrown when an address does not correspond to a valid Uniswap V2 pair (e.g. getReserves reverts or returns zero address). */
export class InvalidPairError extends AppError {
  constructor(address: string, reason?: string, options?: ErrorOptions) {
    super(
      reason != null
        ? `Invalid Uniswap V2 pair at ${address}: ${reason}`
        : `Invalid Uniswap V2 pair at ${address}`,
      options,
    );
  }
}

/** Thrown when a token passed to a pair method does not belong to that pair. */
export class UnknownTokenError extends AppError {
  constructor(tokenAddress: string, pairAddress: string, options?: ErrorOptions) {
    super(`Token ${tokenAddress} is not part of pair ${pairAddress}`, options);
  }
}

/** Thrown when a swap would exhaust pool reserves, or when amountIn / amountOut is zero. */
export class InsufficientLiquidityError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}
