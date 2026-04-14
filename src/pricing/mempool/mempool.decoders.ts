import type { Hex } from 'viem';
import { decodeFunctionData } from 'viem';
import { Address } from '@/core/core.types';
import {
  ABI_SWAP_ETH_FOR_EXACT_TOKENS,
  ABI_SWAP_EXACT_ETH_FOR_TOKENS,
  ABI_SWAP_EXACT_TOKENS_FOR_ETH,
  ABI_SWAP_EXACT_TOKENS_FOR_TOKENS,
  ABI_SWAP_TOKENS_FOR_EXACT_ETH,
  ABI_SWAP_TOKENS_FOR_EXACT_TOKENS,
} from './mempool.constants';
import type { DecodedSwapParams } from './mempool.interfaces';

type Decoder = (data: Hex) => DecodedSwapParams;

function decodeExactTokensForTokens(data: Hex): DecodedSwapParams {
  const { args } = decodeFunctionData({ abi: ABI_SWAP_EXACT_TOKENS_FOR_TOKENS, data });
  const [amountIn, amountOutMin, path, , deadline] = args as [
    bigint,
    bigint,
    readonly `0x${string}`[],
    `0x${string}`,
    bigint,
  ];
  return {
    amountIn,
    amountOutMin,
    path,
    tokenIn: new Address(path[0]!),
    tokenOut: new Address(path[path.length - 1]!),
    deadline,
    isExactIn: true,
  };
}

function decodeExactETHForTokens(data: Hex): DecodedSwapParams {
  const { args } = decodeFunctionData({ abi: ABI_SWAP_EXACT_ETH_FOR_TOKENS, data });
  const [amountOutMin, path, , deadline] = args as [
    bigint,
    readonly `0x${string}`[],
    `0x${string}`,
    bigint,
  ];
  return {
    amountIn: 0n,
    amountOutMin,
    path,
    tokenIn: null,
    tokenOut: new Address(path[path.length - 1]!),
    deadline,
    isExactIn: true,
  };
}

function decodeExactTokensForETH(data: Hex): DecodedSwapParams {
  const { args } = decodeFunctionData({ abi: ABI_SWAP_EXACT_TOKENS_FOR_ETH, data });
  const [amountIn, amountOutMin, path, , deadline] = args as [
    bigint,
    bigint,
    readonly `0x${string}`[],
    `0x${string}`,
    bigint,
  ];
  return {
    amountIn,
    amountOutMin,
    path,
    tokenIn: new Address(path[0]!),
    tokenOut: null,
    deadline,
    isExactIn: true,
  };
}

function decodeTokensForExactTokens(data: Hex): DecodedSwapParams {
  const { args } = decodeFunctionData({ abi: ABI_SWAP_TOKENS_FOR_EXACT_TOKENS, data });
  const [amountOut, amountInMax, path, , deadline] = args as [
    bigint,
    bigint,
    readonly `0x${string}`[],
    `0x${string}`,
    bigint,
  ];
  return {
    amountIn: amountInMax,
    amountOutMin: amountOut,
    path,
    tokenIn: new Address(path[0]!),
    tokenOut: new Address(path[path.length - 1]!),
    deadline,
    isExactIn: false,
  };
}

function decodeTokensForExactETH(data: Hex): DecodedSwapParams {
  const { args } = decodeFunctionData({ abi: ABI_SWAP_TOKENS_FOR_EXACT_ETH, data });
  const [amountOut, amountInMax, path, , deadline] = args as [
    bigint,
    bigint,
    readonly `0x${string}`[],
    `0x${string}`,
    bigint,
  ];
  return {
    amountIn: amountInMax,
    amountOutMin: amountOut,
    path,
    tokenIn: new Address(path[0]!),
    tokenOut: null,
    deadline,
    isExactIn: false,
  };
}

function decodeETHForExactTokens(data: Hex): DecodedSwapParams {
  const { args } = decodeFunctionData({ abi: ABI_SWAP_ETH_FOR_EXACT_TOKENS, data });
  const [amountOut, path, , deadline] = args as [
    bigint,
    readonly `0x${string}`[],
    `0x${string}`,
    bigint,
  ];
  return {
    amountIn: 0n,
    amountOutMin: amountOut,
    path,
    tokenIn: null,
    tokenOut: new Address(path[path.length - 1]!),
    deadline,
    isExactIn: false,
  };
}

/** Maps each 4-byte selector to its ABI-specific decode function. */
export const DECODERS: Record<string, Decoder> = {
  '0x38ed1739': decodeExactTokensForTokens,
  '0x7ff36ab5': decodeExactETHForTokens,
  '0x18cbafe5': decodeExactTokensForETH,
  '0x8803dbee': decodeTokensForExactTokens,
  '0x4a25d94a': decodeTokensForExactETH,
  '0xfb3bdb41': decodeETHForExactTokens,
};
