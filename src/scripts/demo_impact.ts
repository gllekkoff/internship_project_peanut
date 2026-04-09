#!/usr/bin/env tsx
/**
 * Demo 1: Price impact table for the USDC/WETH pool.
 * Loads live reserves from mainnet and prints how much slippage each trade size incurs.
 * Usage: npx tsx src/scripts/demo_impact.ts
 */
import { config } from '@/core/core.config';
import { Address } from '@/core/core.types';
import { ChainClient } from '@/chain/chain.client';
import { UniswapV2Pair } from '@/pricing/uniswap-v2/uniswap-v2.service';
import { PriceImpactAnalyzer } from '@/pricing/uniswap-v2/uniswap-v2.analyzer';

const USDC_WETH = new Address('0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc');

// Trade sizes in USDC (6 decimals)
const SIZES_USDC = [100n, 500n, 1_000n, 5_000n, 10_000n, 50_000n, 100_000n].map(
  (n) => n * 10n ** 6n,
);

function fmtUsdc(raw: bigint): string {
  return `$${(Number(raw) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function fmtWeth(raw: bigint): string {
  return (Number(raw) / 1e18).toFixed(4);
}

function fmtPrice(raw: bigint): string {
  if (raw === 0n) return '$0.00';
  // spotPrice = reserveOut_WETH_raw * 1e18 / reserveIn_USDC_raw
  // human USDC/WETH = 1e30 / spotPrice
  // Derivation: factor in WETH (1e18) and USDC (1e6) decimals → net exponent is 1e30
  const usdcPerWeth = Number(10n ** 30n / raw);
  return `$${usdcPerWeth.toFixed(2)}`;
}

function fmtBps(bps: bigint): string {
  const val = Number(bps);
  if (val < 10) return `${val} bps`;
  return `${(val / 100).toFixed(2)}%`;
}

const client = new ChainClient([config.mainnetRpcUrl]);
const pair = await UniswapV2Pair.fromChain(USDC_WETH, client);

const usdc = pair.token0; // USDC is token0 in this pair
const analyzer = new PriceImpactAnalyzer(pair);
const rows = analyzer.generateImpactTable(usdc, SIZES_USDC);

const spotRaw = pair.getSpotPrice(usdc);
const spotHuman = Number(10n ** 30n / spotRaw);

console.log(`\nPool: ${pair.token0.symbol}/${pair.token1.symbol} @ ${pair.address.value}`);
console.log(
  `Reserves: ${(Number(pair.reserve0) / 1e6).toLocaleString()} USDC | ${(Number(pair.reserve1) / 1e18).toFixed(2)} WETH`,
);
console.log(`Spot price: $${spotHuman.toFixed(2)} / WETH\n`);

const COL = [14, 12, 12, 12, 10];
const header = [
  'Size (USDC)'.padEnd(COL[0]!),
  'Out (WETH)'.padEnd(COL[1]!),
  'Spot'.padEnd(COL[2]!),
  'Exec price'.padEnd(COL[3]!),
  'Impact'.padEnd(COL[4]!),
].join('│ ');

const divider = COL.map((w) => '─'.repeat(w + 1)).join('┼─');

console.log(header);
console.log(divider);

for (const row of rows) {
  console.log(
    [
      fmtUsdc(row.amountIn).padEnd(COL[0]!),
      fmtWeth(row.amountOut).padEnd(COL[1]!),
      fmtPrice(row.spotPriceBefore).padEnd(COL[2]!),
      fmtPrice(row.executionPrice).padEnd(COL[3]!),
      fmtBps(row.priceImpactBps).padEnd(COL[4]!),
    ].join('│ '),
  );
}

const maxSize = analyzer.findMaxSizeForImpact(usdc, 100n); // 1%
console.log(`\nMax size for ≤1% impact: ${fmtUsdc(maxSize)} USDC`);
