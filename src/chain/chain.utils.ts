import type { Hex } from 'viem';
import type { TransactionRequest } from '@/core/core.types';
import { ChainError } from '@/chain/chain.errors';

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

/** Replaces embedded API keys in RPC URLs with [REDACTED] to prevent secret leakage in logs. */
export function redactUrls(message: string): string {
  return message.replace(/https?:\/\/[^\s"')]+/g, (url) => {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.hostname}/[REDACTED]`;
    } catch {
      return '[REDACTED_URL]';
    }
  });
}

/** Maps a TransactionRequest to viem's call/estimateGas parameter shape. */
export function toViemCallParams(tx: TransactionRequest) {
  return {
    to: tx.to.value as Hex,
    value: tx.value.raw,
    ...(tx.data.length > 0 && {
      data: `0x${Buffer.from(tx.data).toString('hex')}` as Hex,
    }),
    ...(tx.nonce !== null && { nonce: tx.nonce }),
    ...(tx.gasLimit !== null && { gas: tx.gasLimit }),
    ...(tx.maxFeePerGas !== null && { maxFeePerGas: tx.maxFeePerGas }),
    ...(tx.maxPriorityFee !== null && { maxPriorityFeePerGas: tx.maxPriorityFee }),
    chainId: tx.chainId,
  };
}
