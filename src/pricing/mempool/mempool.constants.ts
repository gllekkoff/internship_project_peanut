import { parseAbi } from 'viem';
import type { SwapSelector } from './mempool.interfaces';

export const SWAP_SELECTORS: Record<string, SwapSelector> = {
  '0x38ed1739': { dex: 'UniswapV2', method: 'swapExactTokensForTokens' },
  '0x7ff36ab5': { dex: 'UniswapV2', method: 'swapExactETHForTokens' },
  '0x18cbafe5': { dex: 'UniswapV2', method: 'swapExactTokensForETH' },
  '0x8803dbee': { dex: 'UniswapV2', method: 'swapTokensForExactTokens' },
  '0x4a25d94a': { dex: 'UniswapV2', method: 'swapTokensForExactETH' },
  '0xfb3bdb41': { dex: 'UniswapV2', method: 'swapETHForExactTokens' },
  '0x5ae401dc': { dex: 'UniswapV3', method: 'multicall' },
};

// Uniswap V2 Router02 swap function ABIs — not bundled in viem; defined as human-readable strings via parseAbi.
export const ABI_SWAP_EXACT_TOKENS_FOR_TOKENS = parseAbi([
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
]);

export const ABI_SWAP_EXACT_ETH_FOR_TOKENS = parseAbi([
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)',
]);

export const ABI_SWAP_EXACT_TOKENS_FOR_ETH = parseAbi([
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
]);

export const ABI_SWAP_TOKENS_FOR_EXACT_TOKENS = parseAbi([
  'function swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
]);

export const ABI_SWAP_TOKENS_FOR_EXACT_ETH = parseAbi([
  'function swapTokensForExactETH(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
]);

export const ABI_SWAP_ETH_FOR_EXACT_TOKENS = parseAbi([
  'function swapETHForExactTokens(uint256 amountOut, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)',
]);
