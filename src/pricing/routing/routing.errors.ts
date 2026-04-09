import { AppError } from '@/core/core.errors';

/** Thrown when no path exists between two tokens in the pool graph. */
export class NoRouteFoundError extends AppError {
  constructor(tokenInSymbol: string, tokenOutSymbol: string, options?: ErrorOptions) {
    super(`No route found from ${tokenInSymbol} to ${tokenOutSymbol}`, options);
  }
}

/** Thrown when a Route is constructed with an inconsistent pools/path length. */
export class InvalidRouteError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}
