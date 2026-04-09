import { describe, expect, it } from 'vitest';
import { encodeFunctionData } from 'viem';
import type { Transaction } from 'viem';
import {
  ABI_SWAP_EXACT_ETH_FOR_TOKENS,
  ABI_SWAP_EXACT_TOKENS_FOR_ETH,
  ABI_SWAP_EXACT_TOKENS_FOR_TOKENS,
  ABI_SWAP_ETH_FOR_EXACT_TOKENS,
  ABI_SWAP_TOKENS_FOR_EXACT_TOKENS,
} from '@/pricing/mempool/mempool.constants';
import { MempoolConnectionError, SwapDecodeError } from '@/pricing/mempool/mempool.errors';
import { MempoolMonitor, ParsedSwap } from '@/pricing/mempool/mempool.service';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const;
const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F' as const;
const ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D' as const;
const SENDER = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as const;
const TX_HASH = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab' as const;
const DEADLINE = 9_999_999_999n; // far future

/** Minimal Transaction stub — only the fields parseTransaction reads. */
function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    hash: TX_HASH,
    from: SENDER,
    to: ROUTER,
    input: '0x',
    value: 0n,
    gasPrice: 20_000_000_000n, // 20 gwei
    maxFeePerGas: null,
    nonce: 1,
    blockHash: null,
    blockNumber: null,
    transactionIndex: null,
    type: 'legacy',
    gas: 200_000n,
    chainId: 1,
    ...overrides,
  } as unknown as Transaction;
}

// Pre-computed monitor instance (no WS — only used for parseTransaction / decodeSwapParams)
const monitor = new MempoolMonitor('wss://unused', () => {});

// ---------------------------------------------------------------------------
// parseTransaction — filtering
// ---------------------------------------------------------------------------

describe('parseTransaction — filtering', () => {
  it('returns null for empty input', () => {
    expect(monitor.parseTransaction(makeTx({ input: '0x' }))).toBeNull();
  });

  it('returns null when tx.to is null (contract creation)', () => {
    const calldata = encodeFunctionData({
      abi: ABI_SWAP_EXACT_TOKENS_FOR_TOKENS,
      functionName: 'swapExactTokensForTokens',
      args: [1000n, 900n, [USDC, WETH], SENDER, DEADLINE],
    });
    expect(monitor.parseTransaction(makeTx({ to: null, input: calldata }))).toBeNull();
  });

  it('returns null for an unrecognised selector', () => {
    expect(monitor.parseTransaction(makeTx({ input: '0xdeadbeef1234' }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// swapExactTokensForTokens (0x38ed1739)
// ---------------------------------------------------------------------------

describe('swapExactTokensForTokens', () => {
  const amountIn = 2_000n * 10n ** 6n; // 2000 USDC
  const amountOutMin = 990n * 10n ** 15n; // 0.990 WETH min

  const calldata = encodeFunctionData({
    abi: ABI_SWAP_EXACT_TOKENS_FOR_TOKENS,
    functionName: 'swapExactTokensForTokens',
    args: [amountIn, amountOutMin, [USDC, WETH], SENDER, DEADLINE],
  });

  const tx = makeTx({ input: calldata });

  it('parses dex and method correctly', () => {
    const parsed = monitor.parseTransaction(tx)!;
    expect(parsed.dex).toBe('UniswapV2');
    expect(parsed.method).toBe('swapExactTokensForTokens');
  });

  it('extracts tokenIn and tokenOut from path', () => {
    const parsed = monitor.parseTransaction(tx)!;
    expect(parsed.tokenIn!.value.toLowerCase()).toBe(USDC.toLowerCase());
    expect(parsed.tokenOut!.value.toLowerCase()).toBe(WETH.toLowerCase());
  });

  it('extracts amountIn and minAmountOut', () => {
    const parsed = monitor.parseTransaction(tx)!;
    expect(parsed.amountIn).toBe(amountIn);
    expect(parsed.minAmountOut).toBe(amountOutMin);
  });

  it('isExactIn is true', () => {
    expect(monitor.parseTransaction(tx)!.isExactIn).toBe(true);
  });

  it('records router, sender, gasPrice', () => {
    const parsed = monitor.parseTransaction(tx)!;
    expect(parsed.router.value.toLowerCase()).toBe(ROUTER.toLowerCase());
    expect(parsed.sender.value.toLowerCase()).toBe(SENDER.toLowerCase());
    expect(parsed.gasPrice).toBe(20_000_000_000n);
  });

  it('records deadline', () => {
    expect(monitor.parseTransaction(tx)!.deadline).toBe(DEADLINE);
  });
});

// ---------------------------------------------------------------------------
// swapExactETHForTokens (0x7ff36ab5)
// ---------------------------------------------------------------------------

describe('swapExactETHForTokens', () => {
  const ethIn = 1n * 10n ** 18n; // 1 ETH
  const amountOutMin = 1_990n * 10n ** 6n; // 1990 USDC min

  const calldata = encodeFunctionData({
    abi: ABI_SWAP_EXACT_ETH_FOR_TOKENS,
    functionName: 'swapExactETHForTokens',
    args: [amountOutMin, [WETH, USDC], SENDER, DEADLINE],
  });

  const tx = makeTx({ input: calldata, value: ethIn });

  it('tokenIn is null (native ETH)', () => {
    expect(monitor.parseTransaction(tx)!.tokenIn).toBeNull();
  });

  it('tokenOut is USDC', () => {
    const parsed = monitor.parseTransaction(tx)!;
    expect(parsed.tokenOut!.value.toLowerCase()).toBe(USDC.toLowerCase());
  });

  it('amountIn is taken from tx.value', () => {
    expect(monitor.parseTransaction(tx)!.amountIn).toBe(ethIn);
  });

  it('minAmountOut is extracted from calldata', () => {
    expect(monitor.parseTransaction(tx)!.minAmountOut).toBe(amountOutMin);
  });

  it('isExactIn is true', () => {
    expect(monitor.parseTransaction(tx)!.isExactIn).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// swapExactTokensForETH (0x18cbafe5)
// ---------------------------------------------------------------------------

describe('swapExactTokensForETH', () => {
  const amountIn = 1_000n * 10n ** 6n; // 1000 USDC
  const amountOutMin = 490n * 10n ** 15n; // 0.490 ETH min

  const calldata = encodeFunctionData({
    abi: ABI_SWAP_EXACT_TOKENS_FOR_ETH,
    functionName: 'swapExactTokensForETH',
    args: [amountIn, amountOutMin, [USDC, WETH], SENDER, DEADLINE],
  });

  const tx = makeTx({ input: calldata });

  it('tokenOut is null (native ETH)', () => {
    expect(monitor.parseTransaction(tx)!.tokenOut).toBeNull();
  });

  it('tokenIn is USDC', () => {
    const parsed = monitor.parseTransaction(tx)!;
    expect(parsed.tokenIn!.value.toLowerCase()).toBe(USDC.toLowerCase());
  });

  it('extracts amountIn and minAmountOut', () => {
    const parsed = monitor.parseTransaction(tx)!;
    expect(parsed.amountIn).toBe(amountIn);
    expect(parsed.minAmountOut).toBe(amountOutMin);
  });
});

// ---------------------------------------------------------------------------
// swapTokensForExactTokens (0x8803dbee) — exact-out
// ---------------------------------------------------------------------------

describe('swapTokensForExactTokens (exact-out)', () => {
  const amountOut = 1n * 10n ** 18n; // 1 WETH exact
  const amountInMax = 2_050n * 10n ** 6n; // max 2050 USDC

  const calldata = encodeFunctionData({
    abi: ABI_SWAP_TOKENS_FOR_EXACT_TOKENS,
    functionName: 'swapTokensForExactTokens',
    args: [amountOut, amountInMax, [USDC, WETH], SENDER, DEADLINE],
  });

  const tx = makeTx({ input: calldata });
  const parsed = monitor.parseTransaction(tx)!;

  it('isExactIn is false', () => {
    expect(parsed.isExactIn).toBe(false);
  });

  it('amountIn stores the max input (amountInMax)', () => {
    expect(parsed.amountIn).toBe(amountInMax);
  });

  it('minAmountOut stores the exact desired output', () => {
    expect(parsed.minAmountOut).toBe(amountOut);
  });

  it('tokenIn and tokenOut are extracted', () => {
    expect(parsed.tokenIn!.value.toLowerCase()).toBe(USDC.toLowerCase());
    expect(parsed.tokenOut!.value.toLowerCase()).toBe(WETH.toLowerCase());
  });
});

// ---------------------------------------------------------------------------
// swapETHForExactTokens (0xfb3bdb41) — exact-out ETH-in
// ---------------------------------------------------------------------------

describe('swapETHForExactTokens (exact-out, ETH-in)', () => {
  const amountOut = 1_000n * 10n ** 6n; // 1000 USDC exact
  const ethMax = 1n * 10n ** 18n; // max 1 ETH

  const calldata = encodeFunctionData({
    abi: ABI_SWAP_ETH_FOR_EXACT_TOKENS,
    functionName: 'swapETHForExactTokens',
    args: [amountOut, [WETH, USDC], SENDER, DEADLINE],
  });

  const tx = makeTx({ input: calldata, value: ethMax });
  const parsed = monitor.parseTransaction(tx)!;

  it('tokenIn is null (native ETH)', () => {
    expect(parsed.tokenIn).toBeNull();
  });

  it('amountIn is taken from tx.value', () => {
    expect(parsed.amountIn).toBe(ethMax);
  });

  it('minAmountOut holds the exact desired output', () => {
    expect(parsed.minAmountOut).toBe(amountOut);
  });

  it('isExactIn is false', () => {
    expect(parsed.isExactIn).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Multi-hop path (USDC → WETH → DAI)
// ---------------------------------------------------------------------------

describe('multi-hop path', () => {
  it('tokenIn is path[0] and tokenOut is path[last] for a 3-token path', () => {
    const calldata = encodeFunctionData({
      abi: ABI_SWAP_EXACT_TOKENS_FOR_TOKENS,
      functionName: 'swapExactTokensForTokens',
      args: [1000n * 10n ** 6n, 900n * 10n ** 18n, [USDC, WETH, DAI], SENDER, DEADLINE],
    });

    const parsed = monitor.parseTransaction(makeTx({ input: calldata }))!;
    expect(parsed.tokenIn!.value.toLowerCase()).toBe(USDC.toLowerCase());
    expect(parsed.tokenOut!.value.toLowerCase()).toBe(DAI.toLowerCase());
  });
});

// ---------------------------------------------------------------------------
// ParsedSwap.computeSlippageBps
// ---------------------------------------------------------------------------

describe('ParsedSwap.computeSlippageBps', () => {
  const swap = new ParsedSwap(
    TX_HASH,
    { value: ROUTER } as never,
    'UniswapV2',
    'swapExactTokensForTokens',
    { value: USDC } as never,
    { value: WETH } as never,
    2_000n * 10n ** 6n, // amountIn
    950n * 10n ** 15n, // minAmountOut: 0.950 WETH
    DEADLINE,
    { value: SENDER } as never,
    20_000_000_000n,
    true,
  );

  it('returns 0n when expectedOut equals minAmountOut (no slippage configured)', () => {
    expect(swap.computeSlippageBps(950n * 10n ** 15n)).toBe(0n);
  });

  it('returns correct bps: (1000 - 950) / 1000 * 10000 = 500 bps (5%)', () => {
    const expectedOut = 1_000n * 10n ** 15n; // 1.000 WETH expected
    // slippage = (1000 - 950) / 1000 * 10000 = 500
    expect(swap.computeSlippageBps(expectedOut)).toBe(500n);
  });

  it('returns 0n when expectedOut is 0', () => {
    expect(swap.computeSlippageBps(0n)).toBe(0n);
  });

  it('returns 0n when minAmountOut >= expectedOut', () => {
    expect(swap.computeSlippageBps(900n * 10n ** 15n)).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// decodeSwapParams — error handling
// ---------------------------------------------------------------------------

describe('decodeSwapParams error handling', () => {
  it('throws SwapDecodeError for unknown selector', () => {
    expect(() => monitor.decodeSwapParams('0xdeadbeef', '0xdeadbeef' as never)).toThrow(
      SwapDecodeError,
    );
  });

  it('parseTransaction returns null on malformed calldata (not throw)', () => {
    // Valid selector but garbage ABI-encoded body
    const garbage = '0x38ed17390000000000000000000000000000000000000000000000000000000000000bad';
    expect(monitor.parseTransaction(makeTx({ input: garbage }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MempoolMonitor state
// ---------------------------------------------------------------------------

describe('MempoolMonitor state', () => {
  it('isRunning is false before start()', () => {
    const m = new MempoolMonitor('wss://unused', () => {});
    expect(m.isRunning).toBe(false);
  });

  it('throws MempoolConnectionError if started twice', async () => {
    const m = new MempoolMonitor('wss://unused', () => {});
    // Manually set unwatch to simulate a running monitor without a real WS
    Object.defineProperty(m, 'unwatch', { value: () => {}, writable: true, configurable: true });
    await expect(m.start()).rejects.toThrow(MempoolConnectionError);
  });
});
