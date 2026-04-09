import { AppError } from '@/core/core.errors';

export class QuoteError extends AppError {
  /**
  Raised when a price quote cannot be produced (e.g., simulation fails, no route).
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}
