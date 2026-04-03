import type { Hex, TransactionSerializable } from 'viem';
import { TokenAmount, TransactionRequest, Address } from '../core/baseTypes.js';
import type { TransactionReceipt } from '../core/baseTypes.js';
import type { WalletManager } from '../core/walletManager.js';
import type { ChainClient } from './chainClient.js';
import { TransactionFailed } from './errorHandling.js';

/** A serialized signed transaction ready to be broadcast. */
export class SignedTransaction {
  readonly serialized: Hex;

  constructor(serialized: Hex) {
    this.serialized = serialized;
  }

  toBytes(): Uint8Array {
    return Buffer.from(this.serialized.slice(2), 'hex');
  }
}

export class TransactionBuilder {
  /**
   * Fluent builder for EIP-1559 transactions.
   *
   * Synchronous setters configure the transaction. Async resolution
   * (gas estimation, gas price fetch) happens lazily inside build().
   *
   * Usage:
   *   const receipt = await new TransactionBuilder(client, wallet)
   *     .to(recipient)
   *     .value(TokenAmount.fromHuman('0.1', 18))
   *     .withGasEstimate()
   *     .withGasPrice('high')
   *     .sendAndWait();
   */
  private _to: Address | null = null;
  private _value: TokenAmount = new TokenAmount(0n, 18, 'ETH');
  private _data: Uint8Array = new Uint8Array(0);
  private _nonce: number | null = null;
  private _gasLimit: bigint | null = null;
  private _maxFeePerGas: bigint | null = null;
  private _maxPriorityFee: bigint | null = null;
  private _estimateGas = false;
  private _gasBuffer = 1.2;
  private _fetchGasPrice = false;
  private _gasPriority: 'low' | 'medium' | 'high' = 'medium';

  constructor(
    private readonly client: ChainClient,
    private readonly wallet: WalletManager,
  ) {}

  to(address: Address): TransactionBuilder {
    this._to = address;
    return this;
  }

  value(amount: TokenAmount): TransactionBuilder {
    this._value = amount;
    return this;
  }

  data(calldata: Uint8Array): TransactionBuilder {
    this._data = calldata;
    return this;
  }

  /** Explicit nonce — use for replacement transactions or batching. */
  nonce(nonce: number): TransactionBuilder {
    this._nonce = nonce;
    return this;
  }

  gasLimit(limit: bigint): TransactionBuilder {
    this._gasLimit = limit;
    return this;
  }

  /**
   * Estimate gas at build() time and multiply by buffer.
   * Buffer defaults to 1.2× — gives headroom for minor state changes between
   * estimation and inclusion. Uses integer arithmetic, no floats.
   */
  withGasEstimate(buffer: number = 1.2): TransactionBuilder {
    this._estimateGas = true;
    this._gasBuffer = buffer;
    return this;
  }

  /** Fetch current gas price at build() time and set EIP-1559 fee fields. */
  withGasPrice(priority: 'low' | 'medium' | 'high' = 'medium'): TransactionBuilder {
    this._fetchGasPrice = true;
    this._gasPriority = priority;
    return this;
  }

  async build(): Promise<TransactionRequest> {
    if (this._to === null) throw new Error('to address is required');

    let nonce = this._nonce;
    let gasLimit = this._gasLimit;
    let maxFeePerGas = this._maxFeePerGas;
    let maxPriorityFee = this._maxPriorityFee;

    if (nonce === null) {
      const senderAddress = new Address(this.wallet.getAddress());
      nonce = await this.client.getNonce(senderAddress);
    }

    if (this._estimateGas || this._fetchGasPrice) {
      const partialTx = new TransactionRequest(
        this._to,
        this._value,
        this._data,
        nonce,
        null,
        null,
        null,
        this.client.chainId,
      );

      const [estimatedGas, gasPrice] = await Promise.all([
        this._estimateGas ? this.client.estimateGas(partialTx) : Promise.resolve(null),
        this._fetchGasPrice ? this.client.getGasPrice() : Promise.resolve(null),
      ]);

      if (estimatedGas !== null) {
        gasLimit = (estimatedGas * BigInt(Math.round(this._gasBuffer * 1000))) / 1000n;
      }

      if (gasPrice !== null) {
        maxFeePerGas = gasPrice.getMaxFee(this._gasPriority);
        const priorityFees = {
          low: gasPrice.priorityFeeLow,
          medium: gasPrice.priorityFeeMedium,
          high: gasPrice.priorityFeeHigh,
        };
        maxPriorityFee = priorityFees[this._gasPriority];
      }
    }

    return new TransactionRequest(
      this._to,
      this._value,
      this._data,
      nonce,
      gasLimit,
      maxFeePerGas,
      maxPriorityFee,
      this.client.chainId,
    );
  }

  /** Build and sign the transaction without broadcasting. */
  async buildAndSign(): Promise<SignedTransaction> {
    const tx = await this.build();
    const serializable: TransactionSerializable = {
      to: tx.to.value as Hex,
      value: tx.value.raw,
      nonce: tx.nonce ?? 0,
      gas: tx.gasLimit ?? undefined,
      maxFeePerGas: tx.maxFeePerGas ?? undefined,
      maxPriorityFeePerGas: tx.maxPriorityFee ?? undefined,
      chainId: tx.chainId,
      ...(tx.data.length > 0 && {
        data: `0x${Buffer.from(tx.data).toString('hex')}` as Hex,
      }),
    };
    const serialized = await this.wallet.signTransaction(serializable);
    return new SignedTransaction(serialized);
  }

  /** Build, sign, broadcast. Returns the tx hash without waiting for confirmation. */
  async send(): Promise<string> {
    const signed = await this.buildAndSign();
    return this.client.sendTransaction(signed.toBytes());
  }

  /**
   * Build, sign, broadcast, and wait for the transaction to be mined.
   * Throws TransactionFailed if the transaction reverts.
   */
  async sendAndWait(timeout: number = 120): Promise<TransactionReceipt> {
    const txHash = await this.send();
    const receipt = await this.client.waitForReceipt(txHash, timeout);
    if (!receipt.status) {
      throw new TransactionFailed(txHash, receipt);
    }
    return receipt;
  }
}
