#!/usr/bin/env tsx
/**
 * Loads 3 mainnet pools (DAI/WETH, USDC/WETH, DAI/USDC) and ranks every route
 * by net output (gross output minus estimated gas cost converted to output units).
 * Usage: npx tsx src/scripts/demo_routing.ts
 */
import { config } from '@/configs/configs.service';
import { Address } from '@/core/core.types';
import { ChainClient } from '@/chain/chain.client';
import { UniswapV2Pair } from '@/pricing/uniswap-v2/uniswap-v2.service';
import { RouteFinder } from '@/pricing/routing/routing.service';

const PAIR_ADDRS = {
  DAI_WETH: new Address('0xA478c2975Ab1Ea89e8196811F51A7B7Ade33eB11'),
  USDC_WETH: new Address('0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc'),
  DAI_USDC: new Address('0xAE461cA67B15dc8dc81CE7615e0320dA1A9aB8D5'),
};

// 10 000 DAI in (18 decimals)
const AMOUNT_IN = 10_000n * 10n ** 18n;
// Gas price for cost comparison (20 gwei)
const GAS_PRICE_GWEI = 20n;
// 1 ETH ≈ 2000 USDC — used to convert gas cost into output-token (USDC, 6 dec) units.
// Formula from RouteFinder docs: humanOutputPerEth * 10^outputDecimals
const ETH_PRICE_IN_USDC = 2_000n * 10n ** 6n;

function fmtDai(raw: bigint): string {
  return (Number(raw) / 1e18).toFixed(6);
}

function fmtGas(raw: bigint): string {
  return Number(raw).toLocaleString();
}

const client = new ChainClient([config.chain.mainnetRpcUrl]);

console.log('\nLoading pools from mainnet...');
const [daiWeth, usdcWeth, daiUsdc] = await Promise.all([
  UniswapV2Pair.fromChain(PAIR_ADDRS.DAI_WETH, client),
  UniswapV2Pair.fromChain(PAIR_ADDRS.USDC_WETH, client),
  UniswapV2Pair.fromChain(PAIR_ADDRS.DAI_USDC, client),
]);

console.log(`  ${daiWeth.token0.symbol}/${daiWeth.token1.symbol}  @ ${daiWeth.address.value}`);
console.log(`  ${usdcWeth.token0.symbol}/${usdcWeth.token1.symbol} @ ${usdcWeth.address.value}`);
console.log(`  ${daiUsdc.token0.symbol}/${daiUsdc.token1.symbol}  @ ${daiUsdc.address.value}`);

const finder = new RouteFinder([daiWeth, usdcWeth, daiUsdc]);

// DAI is token0 in DAI/WETH and token1 in DAI/USDC — grab from the loaded pair
const dai = daiWeth.token0; // DAI
const usdc = usdcWeth.token0; // USDC

console.log(`\nFinding all routes: ${dai.symbol} → ${usdc.symbol}`);
console.log(`Amount in: ${fmtDai(AMOUNT_IN)} DAI  |  Gas price: ${GAS_PRICE_GWEI} gwei\n`);

const comparisons = finder.compareRoutes(
  dai,
  usdc,
  AMOUNT_IN,
  GAS_PRICE_GWEI,
  3,
  ETH_PRICE_IN_USDC,
);

// USDC has 6 decimals
const fmtUsdc = (raw: bigint) => (Number(raw) / 1e6).toFixed(6);

let rank = 1;
for (const { route, grossOutput, gasEstimate, gasCost, netOutput } of comparisons) {
  console.log(`#${rank++} ${route.toString()}`);
  console.log(`   Gross output : ${fmtUsdc(grossOutput)} USDC`);
  console.log(`   Gas estimate : ${fmtGas(gasEstimate)} units`);
  console.log(`   Gas cost     : ${(Number(gasCost) / 1e18).toFixed(6)} ETH`);
  console.log(`   Net output   : ${fmtUsdc(netOutput)} USDC  ← ranked by this`);
  console.log('');
}

const [best] = finder.findBestRoute(dai, usdc, AMOUNT_IN, GAS_PRICE_GWEI, 3, ETH_PRICE_IN_USDC);
console.log(`Best route: ${best.toString()}`);
