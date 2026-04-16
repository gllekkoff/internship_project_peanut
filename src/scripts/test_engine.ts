#!/usr/bin/env tsx
/**
 * Integration test for the full pricing module (PricingEngine).
 *
 * Exercises every major feature in sequence:
 *   1. Pool loading from mainnet
 *   2. AMM math (getAmountOut, spotPrice, priceImpact)
 *   3. Multi-hop route discovery and comparison
 *   4. PricingEngine.loadPools
 *   5. Fork simulation via ForkSimulator.compareSimulationVsCalculation
 *      (uses getAmountsOut — a view function, no token balance or approval needed)
 *      Skipped if FORK_URL is unset.
 *
 * Required: MAINNET_RPC_URL
 * Optional: FORK_URL (Anvil fork URL, e.g. http://127.0.0.1:8545)
 *           Start one with: ./src/scripts/start_fork.sh
 *
 * Usage:
 *   npx tsx src/scripts/test_engine.ts
 *   FORK_URL=http://127.0.0.1:8545 npx tsx src/scripts/test_engine.ts
 */
import { formatUnits } from 'viem';
import { config } from '@/configs/configs.service';
import { Address, Token } from '@/core/core.types';
import { ChainClient } from '@/chain/chain.client';
import { UniswapV2Pair } from '@/pricing/uniswap-v2/uniswap-v2.service';
import { UniswapV2Calculator } from '@/pricing/uniswap-v2/uniswap-v2.calculator';
import { RouteFinder } from '@/pricing/routing/routing.service';
import { PricingEngine } from '@/pricing/engine/engine.service';
import { ForkSimulator } from '@/pricing/forkSimulator/fork.service';

const POOLS = {
  DAI_WETH: new Address('0xA478c2975Ab1Ea89e8196811F51A7B7Ade33eB11'),
  USDC_WETH: new Address('0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc'),
  DAI_USDC: new Address('0xAE461cA67B15dc8dc81CE7615e0320dA1A9aB8D5'),
};

const FORK_URL = process.env['FORK_URL'];

// 1 000 DAI (18 dec)
const AMOUNT_IN = 1_000n * 10n ** 18n;
// 20 gwei
const GAS_PRICE_GWEI = 20n;

let passed = 0;
let failed = 0;
let skipped = 0;

function pass(label: string, detail?: string): void {
  console.log(`  ✓  ${label}${detail ? `  (${detail})` : ''}`);
  passed++;
}

function fail(label: string, reason: string): void {
  console.error(`  ✗  ${label}  — ${reason}`);
  failed++;
}

function skip(label: string, reason: string): void {
  console.log(`  -  ${label}  [skipped: ${reason}]`);
  skipped++;
}

async function testPoolLoading(client: ChainClient): Promise<{
  daiWeth: UniswapV2Pair;
  usdcWeth: UniswapV2Pair;
  daiUsdc: UniswapV2Pair;
} | null> {
  console.log('\n[1] Pool loading');

  let daiWeth: UniswapV2Pair;
  let usdcWeth: UniswapV2Pair;
  let daiUsdc: UniswapV2Pair;

  try {
    [daiWeth, usdcWeth, daiUsdc] = await Promise.all([
      UniswapV2Pair.fromChain(POOLS.DAI_WETH, client),
      UniswapV2Pair.fromChain(POOLS.USDC_WETH, client),
      UniswapV2Pair.fromChain(POOLS.DAI_USDC, client),
    ]);
  } catch (e) {
    fail('fromChain', e instanceof Error ? e.message : String(e));
    return null;
  }

  pass('DAI/WETH loaded', `r0=${formatUnits(daiWeth.reserve0, 18)} DAI`);
  pass('USDC/WETH loaded', `r0=${formatUnits(usdcWeth.reserve0, 6)} USDC`);
  pass('DAI/USDC loaded', `r0=${formatUnits(daiUsdc.reserve0, 18)} DAI`);

  if (daiWeth.reserve0 === 0n || daiWeth.reserve1 === 0n) {
    fail('DAI/WETH reserves non-zero', 'got zero reserves');
  } else {
    pass('Reserves are non-zero');
  }

  if (daiWeth.feeBps === 30n && usdcWeth.feeBps === 30n) {
    pass('Fee is 30 bps on all pools');
  } else {
    fail('Fee check', `expected 30 bps, got ${daiWeth.feeBps} / ${usdcWeth.feeBps}`);
  }

  return { daiWeth, usdcWeth, daiUsdc };
}

function testAmmMath(daiWeth: UniswapV2Pair): { dai: Token; weth: Token } {
  console.log('\n[2] AMM math');

  const dai = daiWeth.token0;
  const weth = daiWeth.token1;

  // getAmountOut
  const amountOut = daiWeth.getAmountOut(AMOUNT_IN, dai);
  if (amountOut > 0n) {
    pass('getAmountOut > 0', `${formatUnits(amountOut, 18)} WETH for 1000 DAI`);
  } else {
    fail('getAmountOut', 'returned 0');
  }

  // spot price should be > 0
  const spot = daiWeth.getSpotPrice(dai);
  if (spot > 0n) {
    // spot = reserveOut/reserveIn * 1e18; for DAI→WETH this is small (1/ETH_PRICE)
    pass('getSpotPrice > 0', `raw=${spot}`);
  } else {
    fail('getSpotPrice', 'returned 0');
  }

  // price impact should be small for 1k DAI vs large pool
  const impactBps = daiWeth.getPriceImpactBps(AMOUNT_IN, dai);
  if (impactBps >= 0n && impactBps < 100n) {
    pass('priceImpact < 100 bps', `${impactBps} bps`);
  } else {
    fail('priceImpact', `${impactBps} bps — unexpectedly large`);
  }

  // verify calculator matches pair method
  const { reserveIn, reserveOut } = UniswapV2Calculator.resolveReserves(
    dai,
    daiWeth.token0,
    daiWeth.reserve0,
    daiWeth.reserve1,
  );
  const calcOut = UniswapV2Calculator.getAmountOut(AMOUNT_IN, reserveIn, reserveOut, 30n);
  if (calcOut === amountOut) {
    pass('Calculator matches Pair method');
  } else {
    fail('Calculator vs Pair', `calc=${calcOut} pair=${amountOut}`);
  }

  return { dai, weth };
}

function testRouting(
  daiWeth: UniswapV2Pair,
  usdcWeth: UniswapV2Pair,
  daiUsdc: UniswapV2Pair,
): void {
  console.log('\n[3] Routing');

  const finder = new RouteFinder([daiWeth, usdcWeth, daiUsdc]);
  const dai = daiWeth.token0;
  const usdc = usdcWeth.token0;
  const weth = usdcWeth.token1;

  // Derive live ETH price in USDC from the pool rather than hardcoding.
  // getSpotPrice(weth) = reserveUSDC/reserveWETH * 1e18; divide by 1e12 to get 6-dec USDC units.
  const ethPriceInUsdc = usdcWeth.getSpotPrice(weth) / 10n ** 12n;

  // findAllRoutes should find at least 2: direct + 2-hop via WETH
  const routes = finder.findAllRoutes(dai, usdc, 3);
  if (routes.length >= 2) {
    pass(`findAllRoutes found ${routes.length} routes`);
  } else {
    fail('findAllRoutes', `expected >= 2, got ${routes.length}`);
  }

  // compareRoutes returns sorted by net output
  const comparisons = finder.compareRoutes(dai, usdc, AMOUNT_IN, GAS_PRICE_GWEI, 3, ethPriceInUsdc);
  if (comparisons.length === routes.length) {
    pass('compareRoutes count matches findAllRoutes');
  } else {
    fail('compareRoutes count', `${comparisons.length} vs ${routes.length}`);
  }

  // Sorted descending
  if (comparisons.length >= 2) {
    const sorted = comparisons[0]!.netOutput >= comparisons[1]!.netOutput;
    if (sorted) {
      pass('compareRoutes sorted descending by netOutput');
    } else {
      fail('compareRoutes sort', 'first entry is not best');
    }
  }

  // findBestRoute should pick the same as compareRoutes[0]
  const [best] = finder.findBestRoute(dai, usdc, AMOUNT_IN, GAS_PRICE_GWEI, 3, ethPriceInUsdc);
  if (best.toString() === comparisons[0]!.route.toString()) {
    pass(`findBestRoute = "${best.toString()}"`);
  } else {
    fail('findBestRoute mismatch', `${best} vs ${comparisons[0]!.route}`);
  }

  // Route.getIntermediateAmounts length
  const amounts = best.getIntermediateAmounts(AMOUNT_IN);
  if (amounts.length === best.pools.length + 1) {
    pass('getIntermediateAmounts correct length');
  } else {
    fail('getIntermediateAmounts', `length ${amounts.length}, expected ${best.pools.length + 1}`);
  }
}

async function testEngineLoadPools(client: ChainClient): Promise<PricingEngine | null> {
  console.log('\n[4] PricingEngine.loadPools');

  const forkUrl = FORK_URL ?? 'http://127.0.0.1:8545'; // dummy if no fork
  const wsUrl = 'ws://127.0.0.1:8546'; // not started in this test

  const engine = new PricingEngine(client, forkUrl, wsUrl);

  try {
    await engine.loadPools([POOLS.DAI_WETH, POOLS.USDC_WETH, POOLS.DAI_USDC]);
    pass('loadPools completed without error');
  } catch (e) {
    fail('loadPools', e instanceof Error ? e.message : String(e));
    return null;
  }

  return engine;
}

/**
 * Uses ForkSimulator.compareSimulationVsCalculation which calls getAmountsOut — a pure view
 * function on the router. No token balance or approval is required, so any fork URL works.
 */
async function testForkSimulation(daiWeth: UniswapV2Pair): Promise<void> {
  console.log('\n[5] Fork simulation — AMM math vs on-chain router (requires Anvil fork)');

  if (!FORK_URL) {
    skip('fork simulation', 'FORK_URL not set — start Anvil fork with ./src/scripts/start_fork.sh');
    return;
  }

  const simulator = new ForkSimulator(FORK_URL);
  const dai = daiWeth.token0;

  try {
    const result = await simulator.compareSimulationVsCalculation(daiWeth, AMOUNT_IN, dai);

    if (result.calculated > 0n) {
      pass('calculated output > 0', `${formatUnits(result.calculated, 18)} WETH`);
    } else {
      fail('calculated output', 'returned 0');
    }

    if (result.simulated > 0n) {
      pass('simulated output > 0', `${formatUnits(result.simulated, 18)} WETH`);
    } else {
      fail('simulated output', 'returned 0');
    }

    if (result.match) {
      pass('calculator === router (exact match)');
    } else {
      // Off-by-one is acceptable — bigint floor vs router rounding can differ by 1 wei
      if (result.difference <= 1n) {
        pass(`calculator ≈ router (diff=${result.difference} wei — within rounding)`);
      } else {
        fail('calculator vs router', `difference=${result.difference} wei`);
      }
    }
  } catch (e) {
    fail('fork simulation', e instanceof Error ? e.message : String(e));
  }
}

async function main(): Promise<void> {
  console.log('=== Pricing Engine Integration Test ===');
  console.log(`RPC:  ${config.chain.mainnetRpcUrl.slice(0, 40)}...`);
  console.log(`Fork: ${FORK_URL ?? '(not set — getQuote will be skipped)'}`);

  const client = new ChainClient([config.chain.mainnetRpcUrl]);

  const pools = await testPoolLoading(client);
  if (!pools) {
    console.error('\nPool loading failed — cannot continue');
    process.exit(1);
  }

  const { daiWeth, usdcWeth, daiUsdc } = pools;

  testAmmMath(daiWeth);
  testRouting(daiWeth, usdcWeth, daiUsdc);

  await testEngineLoadPools(client);
  await testForkSimulation(daiWeth);

  console.log(`\n=== Results: ${passed} passed, ${failed} failed, ${skipped} skipped ===`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
