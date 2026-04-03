import { TransactionReceipt } from '../core/baseTypes.js';

export class ChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** RPC request failed. Carries the JSON-RPC error code when available. */
export class RPCError extends ChainError {
  readonly code: number | null;

  constructor(message: string, code: number | null = null) {
    super(message);
    this.code = code;
  }
}

/** Transaction was mined but reverted. */
export class TransactionFailed extends ChainError {
  readonly txHash: string;
  readonly receipt: TransactionReceipt;

  constructor(txHash: string, receipt: TransactionReceipt) {
    super(`Transaction ${txHash} reverted`);
    this.txHash = txHash;
    this.receipt = receipt;
  }
}

/** Sender balance is insufficient to cover value + gas. */
export class InsufficientFunds extends ChainError {}

/** Nonce has already been used — transaction cannot be replayed. */
export class NonceTooLow extends ChainError {}

/** Replacement transaction did not offer a high enough gas price. */
export class ReplacementUnderpriced extends ChainError {}

/**
 * Only network/transport errors are retryable.
 * Any typed ChainError (RPC errors, reverts, bad nonce, etc.) is never retried —
 * retrying them wastes time and risks confusion about transaction state.
 */
const RETRYABLE_PATTERNS = [
  'econnrefused',
  'etimedout',
  'econnreset',
  'fetch failed',
  'network error',
  'rate limit',
  'too many requests',
  '429',
  '502',
  '503',
  '504',
] as const;

export function isRetryable(error: unknown): boolean {
  if (error instanceof ChainError) return false;
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return RETRYABLE_PATTERNS.some((pattern) => msg.includes(pattern));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
