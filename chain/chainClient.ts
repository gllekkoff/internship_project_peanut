import type { Chain, Hex, PublicClient } from 'viem';
import { TransactionReceiptNotFoundError, createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { TokenAmount, TransactionReceipt } from '../core/baseTypes.js';
import type { Address, TransactionRequest } from '../core/baseTypes.js';
import { isRetryable, sleep } from './errorHandling.js';

export class GasPrice {
  readonly baseFee: bigint;
  readonly priorityFeeLow: bigint;
  readonly priorityFeeMedium: bigint;
  readonly priorityFeeHigh: bigint;

  constructor(
    baseFee: bigint,
    priorityFeeLow: bigint,
    priorityFeeMedium: bigint,
    priorityFeeHigh: bigint,
  ) {
    this.baseFee = baseFee;
    this.priorityFeeLow = priorityFeeLow;
    this.priorityFeeMedium = priorityFeeMedium;
    this.priorityFeeHigh = priorityFeeHigh;
  }

  /**
   * Calculates maxFeePerGas = floor(baseFee * buffer) + priorityFee.
   *
   * Buffer defaults to 1.2 to handle up to ~2 blocks of base fee growth
   * (EIP-1559 allows max 12.5% increase per block).
   * Uses integer arithmetic — no floats.
   */
  getMaxFee(priority: 'low' | 'medium' | 'high' = 'medium', buffer: number = 1.2): bigint {
    const priorityFees = {
      low: this.priorityFeeLow,
      medium: this.priorityFeeMedium,
      high: this.priorityFeeHigh,
    };
    const bufferedBaseFee = (this.baseFee * BigInt(Math.round(buffer * 1000))) / 1000n;
    return bufferedBaseFee + priorityFees[priority];
  }
}

export class ChainClient {
  private readonly chain: Chain;
  private readonly maxRetries: number;
  private readonly clients: readonly PublicClient[];

  /**
   * @param rpcUrls   Ordered list of RPC endpoints. Requests are tried left-to-right;
   *                  the first one to succeed wins.
   * @param timeout   Per-request timeout in seconds (default 30).
   * @param maxRetries Number of full endpoint-cycle retries on transient errors (default 3).
   * @param chain     Viem chain definition — required for ABI encoding and chain-specific
   *                  behaviour. Defaults to mainnet.
   */
  constructor(
    rpcUrls: string[],
    timeout: number = 30,
    maxRetries: number = 3,
    chain: Chain = mainnet,
  ) {
    if (rpcUrls.length === 0) {
      throw new Error('At least one RPC URL is required');
    }
    this.chain = chain;
    this.maxRetries = maxRetries;
    this.clients = rpcUrls.map((url) =>
      createPublicClient({
        chain,
        transport: http(url, { timeout: timeout * 1000 }),
      }),
    );
  }

  get chainId(): number {
    return this.chain.id;
  }

  /**
   * Runs `fn` against each endpoint in order. On a retryable error all endpoints
   * are tried again after exponential backoff. Non-retryable errors (RPC errors,
   * reverts, bad params) propagate immediately with no retry.
   */
  private async withRetry<T>(
    operation: string,
    fn: (client: PublicClient) => Promise<T>,
  ): Promise<T> {
    let lastError: Error = new Error(`${operation} failed`);

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      for (const client of this.clients) {
        const start = Date.now();
        try {
          const result = await fn(client);
          console.debug(`[ChainClient] ${operation} ok in ${Date.now() - start}ms`);
          return result;
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e));
          lastError = error;
          console.warn(
            `[ChainClient] ${operation} failed (attempt ${attempt + 1}): ${error.message}`,
          );
          if (!isRetryable(error)) {
            throw error;
          }
        }
      }

      if (attempt < this.maxRetries - 1) {
        const delay = 1000 * 2 ** attempt; // 1s → 2s → 4s
        console.debug(`[ChainClient] retrying ${operation} in ${delay}ms`);
        await sleep(delay);
      }
    }

    throw new Error(`${operation} failed after ${this.maxRetries} attempts: ${lastError.message}`);
  }

  /** Returns the ETH balance of an address in wei, wrapped as an 18-decimal TokenAmount. */
  async getBalance(address: Address): Promise<TokenAmount> {
    const raw = await this.withRetry('getBalance', (client) =>
      client.getBalance({ address: address.value as Hex }),
    );
    return new TokenAmount(raw, 18, 'ETH');
  }

  /** Returns the next transaction count (nonce) for an address. */
  async getNonce(address: Address, block: 'pending' | 'latest' = 'pending'): Promise<number> {
    return this.withRetry('getNonce', (client) =>
      client.getTransactionCount({ address: address.value as Hex, blockTag: block }),
    );
  }

  /**
   * Returns current gas price info derived from the last 5 blocks.
   * Priority fees are sampled at the 10th / 50th / 90th percentiles.
   */
  async getGasPrice(): Promise<GasPrice> {
    return this.withRetry('getGasPrice', async (client) => {
      const [block, feeHistory] = await Promise.all([
        client.getBlock(),
        client.getFeeHistory({ blockCount: 5, rewardPercentiles: [10, 50, 90] }),
      ]);

      const baseFee = block.baseFeePerGas ?? 0n;
      const rewards = feeHistory.reward ?? [];

      const medianReward = (percentileIndex: number): bigint => {
        const values = rewards.map((r) => r[percentileIndex] ?? 0n);
        if (values.length === 0) return 0n;
        const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        return sorted[Math.floor(sorted.length / 2)] ?? 0n;
      };

      return new GasPrice(baseFee, medianReward(0), medianReward(1), medianReward(2));
    });
  }

  /** Estimates gas required to execute a transaction. */
  async estimateGas(tx: TransactionRequest): Promise<bigint> {
    return this.withRetry('estimateGas', (client) => client.estimateGas(toViemCallParams(tx)));
  }

  /**
   * Broadcasts a signed serialized transaction.
   * Returns the tx hash immediately — does NOT wait for confirmation.
   * Use waitForReceipt() to confirm.
   */
  async sendTransaction(signedTx: Uint8Array): Promise<string> {
    const hex = `0x${Buffer.from(signedTx).toString('hex')}` as Hex;
    return this.withRetry('sendTransaction', (client) =>
      client.sendRawTransaction({ serializedTransaction: hex }),
    );
  }

  /**
   * Polls for a transaction receipt until it appears or the timeout expires.
   * Throws if the transaction is not confirmed within the timeout.
   */
  async waitForReceipt(
    txHash: string,
    timeout: number = 120,
    pollInterval: number = 1.0,
  ): Promise<TransactionReceipt> {
    const deadline = Date.now() + timeout * 1000;

    while (Date.now() < deadline) {
      const receipt = await this.getReceipt(txHash);
      if (receipt !== null) return receipt;
      await sleep(pollInterval * 1000);
    }

    throw new Error(`Transaction ${txHash} not confirmed within ${timeout}s`);
  }

  /** Returns the raw transaction object by hash. */
  async getTransaction(txHash: string): Promise<Record<string, unknown>> {
    const tx = await this.withRetry('getTransaction', (client) =>
      client.getTransaction({ hash: txHash as Hex }),
    );
    return tx as unknown as Record<string, unknown>;
  }

  /** Returns the receipt for a confirmed transaction, or null if not yet mined. */
  async getReceipt(txHash: string): Promise<TransactionReceipt | null> {
    const raw = await this.withRetry('getReceipt', async (client) => {
      try {
        return await client.getTransactionReceipt({ hash: txHash as Hex });
      } catch (e) {
        if (e instanceof TransactionReceiptNotFoundError) return null;
        throw e;
      }
    });

    if (raw === null) return null;

    return TransactionReceipt.fromWeb3({
      transactionHash: raw.transactionHash,
      blockNumber: Number(raw.blockNumber),
      status: raw.status === 'success',
      gasUsed: raw.gasUsed,
      effectiveGasPrice: raw.effectiveGasPrice,
      logs: raw.logs,
    });
  }

  /**
   * Simulates a transaction via eth_call without broadcasting.
   * Returns the raw return data as hex.
   */
  async call(
    tx: TransactionRequest,
    block: 'latest' | 'pending' | 'earliest' = 'latest',
  ): Promise<Hex> {
    return this.withRetry('call', async (client) => {
      const result = await client.call({ ...toViemCallParams(tx), blockTag: block });
      return result.data ?? '0x';
    });
  }
}

function toViemCallParams(tx: TransactionRequest) {
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
