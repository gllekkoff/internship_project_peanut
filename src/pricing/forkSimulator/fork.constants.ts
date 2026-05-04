import { parseAbi } from 'viem';
import { Address } from '@/core/core.types';

// Uniswap V2 Router02 ABI — not bundled in viem; only functions needed for fork simulation.
export const ROUTER_ABI = parseAbi([
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
]);

/** Seconds added to Date.now() when no explicit deadline is provided. */
export const DEFAULT_DEADLINE_OFFSET = 300n;

/** amountOutMin used for simulation calls — 0 so slippage never causes a revert during dry-runs. */
export const SIMULATION_AMOUNT_OUT_MIN = 0n;

/** Uniswap V2 Router02 — same address on mainnet and Sepolia. */
export const UNISWAP_V2_ROUTER = new Address('0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D');
