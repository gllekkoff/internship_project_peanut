import { AppError } from '@/core/core.errors';

/** Thrown when calldata cannot be decoded into swap parameters. */
export class SwapDecodeError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** Thrown when the WebSocket connection to the node fails or is already active. */
export class MempoolConnectionError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}
