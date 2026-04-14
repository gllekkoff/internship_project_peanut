import type { Chain, Hash, Hex, PublicClient, Transaction } from 'viem';
import { createPublicClient, webSocket } from 'viem';
import { mainnet } from 'viem/chains';
import { Address } from '@/core/core.types';
import { SWAP_SELECTORS } from '@/pricing/mempool/mempool.constants';
import { MempoolConnectionError, SwapDecodeError } from '@/pricing/mempool/mempool.errors';
import type { DecodedSwapParams } from '@/pricing/mempool/mempool.interfaces';
import { DECODERS } from './mempool.decoders';

/**
 * Parsed representation of a pending swap transaction detected in the mempool.
 *
 * tokenIn / tokenOut are null for native ETH legs.
 * amountIn is 0n for ETH-in variants — callers should use tx.value recorded at
 * parse time; this is handled internally before constructing the instance.
 */
export class ParsedSwap {
  constructor(
    readonly txHash: string,
    readonly router: Address,
    readonly dex: string,
    readonly method: string,
    /** null = native ETH. */
    readonly tokenIn: Address | null,
    /** null = native ETH. */
    readonly tokenOut: Address | null,
    readonly amountIn: bigint,
    readonly minAmountOut: bigint,
    readonly deadline: bigint,
    readonly sender: Address,
    readonly gasPrice: bigint,
    /** true = exact-in variant (amountIn fixed); false = exact-out (amountOutMin is exact). */
    readonly isExactIn: boolean,
  ) {}

  /**
   * Returns the implied slippage tolerance in basis points.
   * Requires the expected output for the given amountIn (e.g. from a pool simulation).
   * Returns 0n if no slippage is configured (minAmountOut >= expectedAmountOut).
   */
  computeSlippageBps(expectedAmountOut: bigint): bigint {
    if (expectedAmountOut <= 0n || this.minAmountOut >= expectedAmountOut) return 0n;
    return ((expectedAmountOut - this.minAmountOut) * 10_000n) / expectedAmountOut;
  }
}

export type SwapCallback = (swap: ParsedSwap) => void | Promise<void>;

/**
 * Monitors the mempool via a persistent WebSocket subscription for pending
 * swap transactions from known DEX routers.
 *
 * Subscribes to `eth_subscribe newPendingTransactions` (hashes only), then
 * fetches and parses each transaction asynchronously. The callback is fired
 * with a ParsedSwap for every recognised swap.
 *
 * The callback is fire-and-forget: a slow callback won't back up incoming
 * transactions, and an error inside it is logged but not propagated.
 */
export class MempoolMonitor {
  private readonly wsUrl: string;
  private readonly callback: SwapCallback;
  private readonly chain: Chain;
  private client: PublicClient | null = null;
  private unwatch: (() => void) | null = null;

  constructor(wsUrl: string, callback: SwapCallback, chain: Chain = mainnet) {
    this.wsUrl = wsUrl;
    this.callback = callback;
    this.chain = chain;
  }

  get isRunning(): boolean {
    return this.unwatch !== null;
  }

  /**
   * Opens the WebSocket connection and starts the pending-transaction subscription.
   */
  async start(): Promise<void> {
    if (this.isRunning) throw new MempoolConnectionError('Monitor is already running');

    this.client = createPublicClient({
      chain: this.chain,
      transport: webSocket(this.wsUrl),
    });

    this.unwatch = this.client.watchPendingTransactions({
      onTransactions: (hashes) => void this.handleHashes(hashes),
      onError: (err) => console.error('[MempoolMonitor] subscription error:', err),
    });
  }

  stop(): void {
    this.unwatch?.();
    this.unwatch = null;
    this.client = null;
  }

  /**
   * Attempts to parse a raw viem Transaction into a ParsedSwap.
   * Returns null for non-swap transactions, unrecognised selectors, or decode failures.
   */
  parseTransaction(tx: Transaction): ParsedSwap | null {
    if (!tx.input || tx.input === '0x' || tx.to === null) return null;

    const selector = tx.input.slice(0, 10).toLowerCase() as Hex;
    const selectorInfo = SWAP_SELECTORS[selector];
    if (!selectorInfo) return null;

    try {
      const params = this.decodeSwapParams(selector, tx.input as Hex, tx.value);
      return new ParsedSwap(
        tx.hash,
        new Address(tx.to),
        selectorInfo.dex,
        selectorInfo.method,
        params.tokenIn,
        params.tokenOut,
        params.amountIn,
        params.amountOutMin,
        params.deadline,
        new Address(tx.from),
        tx.gasPrice ?? tx.maxFeePerGas ?? 0n,
        params.isExactIn,
      );
    } catch {
      return null;
    }
  }

  /**
   * Decodes swap calldata using the per-function ABI for the given selector.
   * For ETH-input functions, txValue is substituted as amountIn.
   */
  decodeSwapParams(selector: string, data: Hex, txValue: bigint = 0n): DecodedSwapParams {
    const decode = DECODERS[selector.toLowerCase()];
    if (!decode) throw new SwapDecodeError(`Unsupported selector: ${selector}`);

    const params = decode(data);

    if (params.tokenIn === null && params.amountIn === 0n) {
      return { ...params, amountIn: txValue };
    }
    return params;
  }

  private async handleHashes(hashes: Hash[]): Promise<void> {
    await Promise.all(
      hashes.map(async (hash) => {
        try {
          const tx = await this.client!.getTransaction({ hash });
          const parsed = this.parseTransaction(tx);
          if (parsed !== null) {
            // Fire-and-forget: callback errors are logged, not propagated
            void Promise.resolve(this.callback(parsed)).catch((err) =>
              console.error('[MempoolMonitor] callback error:', err),
            );
          }
        } catch (e) {
          console.error('[MempoolMonitor] getTransaction error:', e);
        }
      }),
    );
  }
}
