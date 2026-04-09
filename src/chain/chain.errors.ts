import { AppError } from '@/core/core.errors';
import { TransactionReceipt } from '@/core/core.types';

/**
 * Base class for all chain/RPC domain errors.
 * Pass `{ cause: originalError }` when rethrowing to preserve the original stack trace.
 * Sanitize messages at the log boundary via `redactUrls` in chain.utils.ts — never embed
 * raw RPC URLs or sensitive call data in messages.
 */
export class ChainError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** RPC request failed. Carries the JSON-RPC error code when available. */
export class RPCError extends ChainError {
  readonly code: number | null;

  constructor(message: string, code: number | null = null, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

/** Transaction was mined but reverted. */
export class TransactionFailed extends ChainError {
  readonly txHash: string;
  readonly receipt: TransactionReceipt;

  constructor(txHash: string, receipt: TransactionReceipt, options?: ErrorOptions) {
    super(`Transaction ${txHash} reverted`, options);
    this.txHash = txHash;
    this.receipt = receipt;
  }
}

/** Sender balance is insufficient to cover value + gas. */
export class InsufficientFunds extends ChainError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** Nonce has already been used — transaction cannot be replayed. */
export class NonceTooLow extends ChainError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** Replacement transaction did not offer a high enough gas price. */
export class ReplacementUnderpriced extends ChainError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}
