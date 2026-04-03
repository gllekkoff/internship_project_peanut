import { parseAbi, formatUnits } from 'viem';
import 'dotenv/config';

export const DEFAULT_RPC = process.env['MAINNET_RPC_URL'] ?? 'https://eth.llamarpc.com';

export const FUNCTION_ABIS = parseAbi([
  // ERC-20
  'function transfer(address to, uint256 value)',
  'function approve(address spender, uint256 value)',
  'function transferFrom(address from, address to, uint256 value)',
  'function mint(address to, uint256 amount)',
  'function burn(uint256 amount)',
  // ERC-721
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
  'function setApprovalForAll(address operator, bool approved)',
  // WETH
  'function deposit()',
  'function withdraw(uint256 wad)',
  // Uniswap V2 Router
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline)',
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function swapTokensForExactETH(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline)',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline)',
  'function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline)',
  'function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline)',
  'function removeLiquidityETH(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline)',
  // Uniswap V3 Router
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params)',
  'function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) params)',
  'function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96) params)',
  'function exactOutput((bytes path, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum) params)',
  'function multicall(bytes[] data)',
  // Aave V3
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to)',
  'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)',
  'function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)',
]);

export const TRANSFER_ABI = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

export const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const W = 18;
export const row = (label: string, value: string) => console.log(`${label.padEnd(W)}${value}`);
export const sep = (title: string) => console.log(`\n${title}\n${'-'.repeat(title.length)}`);
export const gwei = (v: bigint) => `${formatUnits(v, 9)} gwei`;
export const pct = (used: bigint, limit: bigint) =>
  `${((Number(used) / Number(limit)) * 100).toFixed(2)}%`;
export const ts = (t: bigint) =>
  new Date(Number(t) * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
