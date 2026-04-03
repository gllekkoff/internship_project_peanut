import { getAddress, isAddress, keccak256 } from 'viem';

export class Address {
  readonly value: string;

  constructor(value: string) {
    if (!isAddress(value)) {
      throw new Error(`Invalid Ethereum address: ${value}`);
    }
    this.value = getAddress(value);
  }

  static fromString(s: string): Address {
    return new Address(s);
  }

  get checksum(): string {
    return this.value;
  }

  get lower(): string {
    return this.value.toLowerCase();
  }

  equals(other: Address): boolean {
    return this.lower === other.lower;
  }

  toString(): string {
    return this.value;
  }
}

export class TokenAmount {
  readonly raw: bigint;
  readonly decimals: number;
  readonly symbol: string | null;

  constructor(raw: bigint, decimals: number, symbol: string | null = null) {
    this.raw = raw;
    this.decimals = decimals;
    this.symbol = symbol;
  }

  static fromHuman(amount: string, decimals: number, symbol: string | null = null): TokenAmount {
    const parts = amount.split('.');
    if (parts.length > 2) {
      throw new Error(`Invalid amount format: "${amount}"`);
    }

    const intStr = parts[0] ?? '0';
    const fracStr = parts[1] ?? '';
    if (fracStr.length > decimals) {
      throw new RangeError(
        `Amount has more decimal places (${fracStr.length}) than token decimals (${decimals})`,
      );
    }

    const scale = 10n ** BigInt(decimals);
    const intPart = BigInt(intStr) * scale;
    const fracPart =
      fracStr.length > 0 ? BigInt(fracStr) * 10n ** BigInt(decimals - fracStr.length) : 0n;

    return new TokenAmount(intPart + fracPart, decimals, symbol);
  }

  get human(): string {
    return (this.raw / 10n ** BigInt(this.decimals)).toString();
  }

  add(other: TokenAmount): TokenAmount {
    if (this.decimals !== other.decimals) {
      throw new Error(
        `Cannot add TokenAmounts with different decimals: ${this.decimals} vs ${other.decimals}`,
      );
    }
    return new TokenAmount(this.raw + other.raw, this.decimals, this.symbol);
  }

  mul(factor: bigint | number): TokenAmount {
    return new TokenAmount(this.raw * BigInt(factor), this.decimals, this.symbol);
  }

  toString(): string {
    return `${this.human} ${this.symbol ?? ''}`;
  }
}

export class Token {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;

  constructor(address: Address, symbol: string, decimals: number) {
    this.address = address;
    this.symbol = symbol;
    this.decimals = decimals;
  }

  equals(other: Token): boolean {
    return this.address.equals(other.address);
  }

  toString(): string {
    return `${this.symbol} (${this.address})`;
  }

  hash(): string {
    return keccak256(this.address.lower as `0x${string}`);
  }
}

export class TransactionRequest {
  readonly to: Address;
  readonly value: TokenAmount;
  readonly data: Uint8Array;
  readonly nonce: number | null;
  readonly gasLimit: bigint | null;
  readonly maxFeePerGas: bigint | null;
  readonly maxPriorityFee: bigint | null;
  readonly chainId: number;

  constructor(
    to: Address,
    value: TokenAmount,
    data: Uint8Array,
    nonce: number | null = null,
    gasLimit: bigint | null = null,
    maxFeePerGas: bigint | null = null,
    maxPriorityFee: bigint | null = null,
    chainId: number = 1,
  ) {
    this.to = to;
    this.value = value;
    this.data = data;
    this.nonce = nonce;
    this.gasLimit = gasLimit;
    this.maxFeePerGas = maxFeePerGas;
    this.maxPriorityFee = maxPriorityFee;
    this.chainId = chainId;
  }

  toDict(): Record<string, unknown> {
    return {
      to: this.to.value,
      value: this.value.human,
      data: this.data,
      nonce: this.nonce,
      gasLimit: this.gasLimit,
      maxFeePerGas: this.maxFeePerGas,
      maxPriorityFee: this.maxPriorityFee,
      chainId: this.chainId,
    };
  }
}

export class TransactionReceipt {
  readonly txHash: string;
  readonly blockNumber: number;
  readonly status: boolean;
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
  readonly logs: unknown[];

  constructor(
    txHash: string,
    blockNumber: number,
    status: boolean,
    gasUsed: bigint,
    effectiveGasPrice: bigint,
    logs: unknown[],
  ) {
    this.txHash = txHash;
    this.blockNumber = blockNumber;
    this.status = status;
    this.gasUsed = gasUsed;
    this.effectiveGasPrice = effectiveGasPrice;
    this.logs = logs;
  }

  get txFee(): TokenAmount {
    return new TokenAmount(this.gasUsed * this.effectiveGasPrice, 18);
  }

  static fromWeb3(receipt: Record<string, unknown>): TransactionReceipt {
    return new TransactionReceipt(
      receipt['transactionHash'] as string,
      receipt['blockNumber'] as number,
      receipt['status'] as boolean,
      receipt['gasUsed'] as bigint,
      receipt['effectiveGasPrice'] as bigint,
      receipt['logs'] as unknown[],
    );
  }
}
