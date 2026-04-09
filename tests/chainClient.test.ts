import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ChainClient } from '@/chain/chain.client';
import { GasPrice } from '@/chain/gas.calculator';
import { ChainError, RPCError } from '@/chain/chain.errors';
import { mainnet } from 'viem/chains';

describe('GasPrice', () => {
  const gasPrice = new GasPrice(10_000_000_000n, 1_000_000_000n, 2_000_000_000n, 3_000_000_000n);

  it('stores all fee fields', () => {
    expect(gasPrice.baseFee).toBe(10_000_000_000n);
    expect(gasPrice.priorityFeeLow).toBe(1_000_000_000n);
    expect(gasPrice.priorityFeeMedium).toBe(2_000_000_000n);
    expect(gasPrice.priorityFeeHigh).toBe(3_000_000_000n);
  });

  it('getMaxFee medium = floor(baseFee * 1.2) + priorityMedium', () => {
    const expected = (10_000_000_000n * 1200n) / 1000n + 2_000_000_000n;
    expect(gasPrice.getMaxFee('medium')).toBe(expected);
  });

  it('getMaxFee low uses low priority fee', () => {
    const expected = (10_000_000_000n * 1200n) / 1000n + 1_000_000_000n;
    expect(gasPrice.getMaxFee('low')).toBe(expected);
  });

  it('getMaxFee high uses high priority fee', () => {
    const expected = (10_000_000_000n * 1200n) / 1000n + 3_000_000_000n;
    expect(gasPrice.getMaxFee('high')).toBe(expected);
  });

  it('getMaxFee defaults to medium priority', () => {
    expect(gasPrice.getMaxFee()).toBe(gasPrice.getMaxFee('medium'));
  });

  it('getMaxFee uses custom buffer', () => {
    const expected = (10_000_000_000n * 1500n) / 1000n + 2_000_000_000n;
    expect(gasPrice.getMaxFee('medium', 1.5)).toBe(expected);
  });

  it('getMaxFee uses integer arithmetic — no floats leak into result', () => {
    const result = gasPrice.getMaxFee('medium', 1.2);
    expect(typeof result).toBe('bigint');
  });

  it('getMaxFee with zero baseFee returns only priority fee', () => {
    const zeroBase = new GasPrice(0n, 1n, 2n, 3n);
    expect(zeroBase.getMaxFee('medium')).toBe(2n);
  });

  it('getMaxFee buffer of 1.0 does not amplify baseFee', () => {
    const result = gasPrice.getMaxFee('medium', 1.0);
    expect(result).toBe(10_000_000_000n + 2_000_000_000n);
  });
});

describe('ChainClient constructor', () => {
  it('throws when rpcUrls is empty', () => {
    expect(() => new ChainClient([])).toThrow('At least one RPC URL is required');
  });

  it('accepts a single RPC URL', () => {
    expect(() => new ChainClient(['https://rpc.example.com'])).not.toThrow();
  });

  it('accepts multiple RPC URLs', () => {
    expect(
      () => new ChainClient(['https://rpc1.example.com', 'https://rpc2.example.com']),
    ).not.toThrow();
  });

  it('exposes chainId from the chain definition', () => {
    const client = new ChainClient(['https://rpc.example.com'], 30, 3, mainnet);
    expect(client.chainId).toBe(1);
  });
});

describe('ChainClient retry logic', () => {
  const makeFailingClient = (error: Error, succeedOnAttempt = Infinity) => {
    let calls = 0;
    return {
      getBalance: vi.fn(async () => {
        calls++;
        if (calls < succeedOnAttempt) throw error;
        return 1000n;
      }),
      getTransactionCount: vi.fn().mockResolvedValue(0),
      getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 10n, timestamp: 0n }),
      getFeeHistory: vi.fn().mockResolvedValue({ reward: [[1n, 2n, 3n]] }),
      estimateGas: vi.fn().mockResolvedValue(21000n),
      sendRawTransaction: vi.fn().mockResolvedValue('0xhash'),
      getTransactionReceipt: vi.fn().mockResolvedValue(null),
      call: vi.fn().mockResolvedValue({ data: '0x' }),
    };
  };

  it('does not retry on ChainError', async () => {
    const { createPublicClient } = await import('viem');
    const mockViem = vi.spyOn({ createPublicClient }, 'createPublicClient');

    const client = new ChainClient(['https://rpc.example.com'], 1, 3, mainnet);
    const inner = (client as unknown as { clients: { getBalance: ReturnType<typeof vi.fn> }[] })
      .clients[0];

    if (inner) {
      inner.getBalance = vi.fn().mockRejectedValue(new RPCError('method not found', -32601));
      await expect(
        client.getBalance({ value: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' } as never),
      ).rejects.toBeInstanceOf(ChainError);
      expect(inner.getBalance).toHaveBeenCalledTimes(1);
    }

    mockViem.mockRestore();
  });
});
