#!/usr/bin/env tsx
/**
 * Verifies that UniswapV2Calculator matches the on-chain router's getAmountsOut exactly.
 *
 * Requires a running Anvil fork — start one with src/scripts/start_fork.sh
 * Usage: npx tsx src/scripts/verify_amm.ts
 */
import { formatUnits } from 'viem';
import { config } from '@/configs/configs.service';
import { Address } from '@/core/core.types';
import { ChainClient } from '@/chain/chain.client';
import { UniswapV2Pair } from '@/pricing/uniswap-v2/uniswap-v2.service';
import { ForkSimulator } from '@/pricing/forkSimulator/fork.service';

const FORK_URL = normalizeUrl(process.env['FORK_URL'] ?? '127.0.0.1:8545');

function normalizeUrl(url: string): string {
  return url.startsWith('http://') || url.startsWith('https://') ? url : `http://${url}`;
}

const ROUTER = new Address('0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D');
const PAIR_ADDR = new Address('0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc'); // USDC/WETH

void config;

const client = new ChainClient([FORK_URL]);
const sim = new ForkSimulator(FORK_URL);

console.log('=== AMM Math Verification ===');
console.log(`Fork:   ${FORK_URL}`);
console.log(`Router: ${ROUTER.value}`);
console.log(`Pair:   ${PAIR_ADDR.value}`);
console.log();

console.log('Loading pair state from fork...');
const pair = await UniswapV2Pair.fromChain(PAIR_ADDR, client);
const tokenIn = pair.token0; // USDC
const tokenOut = pair.token1; // WETH

const reserve0Human = formatUnits(pair.reserve0, tokenIn.decimals);
const reserve1Human = formatUnits(pair.reserve1, tokenOut.decimals);
const spotPriceRaw = (pair.reserve1 * 10n ** 30n) / pair.reserve0; // WETH/USDC scaled
const spotUsdc = (Number(spotPriceRaw) / 1e30) * 1e12; // convert raw scaled price to USDC per WETH

console.log(`Pair:       ${tokenIn.symbol}/${tokenOut.symbol}`);
console.log(`Reserve0:   ${Number(reserve0Human).toLocaleString()} ${tokenIn.symbol}`);
console.log(`Reserve1:   ${Number(reserve1Human).toLocaleString()} ${tokenOut.symbol}`);
console.log(`Spot price: ~$${spotUsdc.toFixed(2)} ${tokenIn.symbol}/${tokenOut.symbol}`);
console.log();

const amountIn = 2_000n * 10n ** 6n; // 2000 USDC
console.log(
  `Simulating swap: ${formatUnits(amountIn, tokenIn.decimals)} ${tokenIn.symbol} → ${tokenOut.symbol}`,
);
console.log(`  Our calculator:  getAmountOut(${amountIn})`);
console.log(
  `  On-chain router: getAmountsOut(${amountIn}, [${tokenIn.symbol}, ${tokenOut.symbol}])`,
);
console.log();

const result = await sim.compareSimulationVsCalculation(pair, amountIn, tokenIn);

const calcHuman = formatUnits(result.calculated, tokenOut.decimals);
const simHuman = formatUnits(result.simulated, tokenOut.decimals);

console.log('Results:');
console.log(`  Calculated (TS): ${calcHuman} ${tokenOut.symbol}  (${result.calculated} wei)`);
console.log(`  Simulated (EVM): ${simHuman} ${tokenOut.symbol}  (${result.simulated} wei)`);
console.log(`  Difference:      ${result.difference} wei`);
console.log(`  Match:           ${result.match ? 'Match' : 'MISMATCH'}`);

if (!result.match) {
  console.error('\nMath mismatch — calculator does not match the contract.');
  process.exit(1);
}
