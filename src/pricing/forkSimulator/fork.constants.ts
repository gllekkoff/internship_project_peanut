import { parseAbi } from 'viem';

// Uniswap V2 Router02 ABI — not bundled in viem; only functions needed for fork simulation.
export const ROUTER_ABI = parseAbi([
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
]);

/** Seconds added to Date.now() when no explicit deadline is provided. */
export const DEFAULT_DEADLINE_OFFSET = 300n;

/** amountOutMin used for simulation calls — 0 so slippage never causes a revert during dry-runs. */
export const SIMULATION_AMOUNT_OUT_MIN = 0n;
