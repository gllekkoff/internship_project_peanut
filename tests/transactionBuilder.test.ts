import { describe, expect, it, vi } from 'vitest';
import { TransactionBuilder, SignedTransaction } from '@/chain/transaction.service';
import { GasPrice } from '@/chain/gas.calculator';
import { TransactionFailed } from '@/chain/chain.errors';
import { Address, TokenAmount, TransactionReceipt } from '@/core/core.types';
import type { ChainClient } from '@/chain/chain.client';
import type { WalletManager } from '@/core/wallet.service';

const ADDR = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const ADDR2 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

const mockGasPrice = new GasPrice(10_000_000_000n, 1_000_000_000n, 2_000_000_000n, 3_000_000_000n);

function makeClient(overrides: Partial<Record<string, unknown>> = {}): ChainClient {
  return {
    chainId: 1,
    getNonce: vi.fn().mockResolvedValue(5),
    estimateGas: vi.fn().mockResolvedValue(21000n),
    getGasPrice: vi.fn().mockResolvedValue(mockGasPrice),
    sendTransaction: vi.fn().mockResolvedValue('0xdeadbeef'),
    waitForReceipt: vi
      .fn()
      .mockResolvedValue(
        new TransactionReceipt('0xdeadbeef', 19000000, true, 21000n, 5_000_000_000n, []),
      ),
    ...overrides,
  } as unknown as ChainClient;
}

function makeWallet(overrides: Partial<Record<string, unknown>> = {}): WalletManager {
  return {
    getAddress: vi.fn().mockReturnValue(ADDR),
    signTransaction: vi.fn().mockResolvedValue('0x02f8ab' as `0x${string}`),
    ...overrides,
  } as unknown as WalletManager;
}

describe('SignedTransaction', () => {
  it('stores serialized hex', () => {
    const signed = new SignedTransaction('0xdeadbeef' as `0x${string}`);
    expect(signed.serialized).toBe('0xdeadbeef');
  });

  it('toBytes strips 0x prefix and returns Uint8Array', () => {
    const signed = new SignedTransaction('0xdeadbeef' as `0x${string}`);
    const bytes = signed.toBytes();
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });
});

describe('TransactionBuilder fluent API', () => {
  it('to() returns the same builder instance', () => {
    const client = makeClient();
    const wallet = makeWallet();
    const builder = new TransactionBuilder(client, wallet);
    expect(builder.to(new Address(ADDR))).toBe(builder);
  });

  it('value() returns the same builder instance', () => {
    const client = makeClient();
    const wallet = makeWallet();
    const builder = new TransactionBuilder(client, wallet);
    expect(builder.value(new TokenAmount(1n, 18))).toBe(builder);
  });

  it('withGasEstimate() returns the same builder instance', () => {
    const client = makeClient();
    const wallet = makeWallet();
    const builder = new TransactionBuilder(client, wallet);
    expect(builder.withGasEstimate()).toBe(builder);
  });

  it('withGasPrice() returns the same builder instance', () => {
    const client = makeClient();
    const wallet = makeWallet();
    const builder = new TransactionBuilder(client, wallet);
    expect(builder.withGasPrice()).toBe(builder);
  });

  it('nonce() returns the same builder instance', () => {
    const client = makeClient();
    const wallet = makeWallet();
    const builder = new TransactionBuilder(client, wallet);
    expect(builder.nonce(0)).toBe(builder);
  });
});

describe('TransactionBuilder.build()', () => {
  it('throws if to address is not set', async () => {
    const builder = new TransactionBuilder(makeClient(), makeWallet());
    await expect(builder.build()).rejects.toThrow('to address is required');
  });

  it('fetches nonce automatically when not set', async () => {
    const client = makeClient();
    const builder = new TransactionBuilder(client, makeWallet()).to(new Address(ADDR)).nonce(7);
    const tx = await builder.build();
    expect(tx.nonce).toBe(7);
    expect(client.getNonce as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('auto-fetches nonce from client when not provided', async () => {
    const client = makeClient();
    const tx = await new TransactionBuilder(client, makeWallet()).to(new Address(ADDR)).build();
    expect(client.getNonce as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    expect(tx.nonce).toBe(5);
  });

  it('applies gas estimate with 1.2x buffer', async () => {
    const client = makeClient();
    const tx = await new TransactionBuilder(client, makeWallet())
      .to(new Address(ADDR))
      .withGasEstimate(1.2)
      .build();
    expect(tx.gasLimit).toBe((21000n * 1200n) / 1000n);
  });

  it('applies custom gas buffer', async () => {
    const client = makeClient();
    const tx = await new TransactionBuilder(client, makeWallet())
      .to(new Address(ADDR))
      .withGasEstimate(1.5)
      .build();
    expect(tx.gasLimit).toBe((21000n * 1500n) / 1000n);
  });

  it('fetches and sets gas price fields', async () => {
    const client = makeClient();
    const tx = await new TransactionBuilder(client, makeWallet())
      .to(new Address(ADDR))
      .withGasPrice('medium')
      .build();
    expect(tx.maxFeePerGas).toBe(mockGasPrice.getMaxFee('medium'));
    expect(tx.maxPriorityFee).toBe(mockGasPrice.priorityFeeMedium);
  });

  it('fetches gas estimate and price in parallel', async () => {
    const client = makeClient();
    await new TransactionBuilder(client, makeWallet())
      .to(new Address(ADDR))
      .withGasEstimate()
      .withGasPrice()
      .build();
    expect(client.estimateGas as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(client.getGasPrice as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it('sets chainId from client', async () => {
    const tx = await new TransactionBuilder(makeClient(), makeWallet())
      .to(new Address(ADDR))
      .build();
    expect(tx.chainId).toBe(1);
  });

  it('sets value on the transaction', async () => {
    const value = TokenAmount.fromHuman('0.5', 18, 'ETH');
    const tx = await new TransactionBuilder(makeClient(), makeWallet())
      .to(new Address(ADDR))
      .value(value)
      .build();
    expect(tx.value.raw).toBe(value.raw);
  });

  it('gasLimit is null when withGasEstimate not called', async () => {
    const tx = await new TransactionBuilder(makeClient(), makeWallet())
      .to(new Address(ADDR))
      .build();
    expect(tx.gasLimit).toBeNull();
  });

  it('maxFeePerGas is null when withGasPrice not called', async () => {
    const tx = await new TransactionBuilder(makeClient(), makeWallet())
      .to(new Address(ADDR))
      .build();
    expect(tx.maxFeePerGas).toBeNull();
  });
});

describe('TransactionBuilder.sendAndWait()', () => {
  it('throws TransactionFailed when receipt status is false', async () => {
    const client = makeClient({
      waitForReceipt: vi
        .fn()
        .mockResolvedValue(new TransactionReceipt('0xdeadbeef', 1, false, 21000n, 1n, [])),
    });
    await expect(
      new TransactionBuilder(client, makeWallet()).to(new Address(ADDR)).sendAndWait(),
    ).rejects.toBeInstanceOf(TransactionFailed);
  });

  it('returns receipt on success', async () => {
    const receipt = new TransactionReceipt('0xdeadbeef', 1, true, 21000n, 1n, []);
    const client = makeClient({ waitForReceipt: vi.fn().mockResolvedValue(receipt) });
    const result = await new TransactionBuilder(client, makeWallet())
      .to(new Address(ADDR))
      .sendAndWait();
    expect(result).toBe(receipt);
  });

  it('send() returns tx hash without waiting', async () => {
    const hash = await new TransactionBuilder(makeClient(), makeWallet())
      .to(new Address(ADDR))
      .send();
    expect(hash).toBe('0xdeadbeef');
  });
});
