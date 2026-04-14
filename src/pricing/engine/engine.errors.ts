import { AppError } from '@/core/core.errors';

/** Raised when a price quote cannot be produced — simulation failed, no route, or pools not loaded. */
export class QuoteError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}
