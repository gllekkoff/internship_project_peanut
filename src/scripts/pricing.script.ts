#!/usr/bin/env tsx
/**
 * Pricing engine integration demo.
 * Loads live pools, runs AMM math, finds best route, and calls getQuote()
 * with fork simulation if FORK_URL is available.
 *
 * Usage:
 *   npx tsx src/scripts/pricing.script.ts
 *   FORK_URL=http://127.0.0.1:8545 npx tsx src/scripts/pricing.script.ts
 */
import { formatUnits } from 'viem';
import { config } from '@/configs/configs.service';
import { Address } from '@/core/core.types';
import { ChainClient } from '@/chain/chain.client';
import { UniswapV2Pair } from '@/pricing/uniswap-v2/uniswap-v2.service';
import { PricingEngine } from '@/pricing/engine/engine.service';
import { QuoteError } from '@/pricing/engine/engine.errors';

const POOLS = {
  DAI_WETH: new Address('0xA478c2975Ab1Ea89e8196811F51A7B7Ade33eB11'),
  USDC_WETH: new Address('0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc'),
  DAI_USDC: new Address('0xAE461cA67B15dc8dc81CE7615e0320dA1A9aB8D5'),
};

const FORK_URL = process.env['FORK_URL'];
const WS_URL = process.env['WS_URL'] ?? 'ws://127.0.0.1:8546';

// 1 000 DAI (18 dec)
const AMOUNT_IN = 1_000n * 10n ** 18n;
const GAS_PRICE_GWEI = 20n;

const SEP = '═'.repeat(50);
const LINE = '─'.repeat(50);

async function main(): Promise<void> {
  console.log(`\n${SEP}`);
  console.log('  Pricing Engine — Integration Demo');
  console.log(SEP);
  console.log(`  RPC:  ${config.chain.mainnetRpcUrl.slice(0, 45)}...`);
  console.log(`  Fork: ${FORK_URL ?? '(not set — getQuote will be skipped)'}`);
  console.log(LINE);

  const client = new ChainClient([config.chain.mainnetRpcUrl]);
  const engine = new PricingEngine(client, FORK_URL ?? 'http://127.0.0.1:8545', WS_URL);

  // ── 1. Load pools ────────────────────────────────────────────────────────────
  console.log('\n[1] Loading pools from mainnet...');
  await engine.loadPools([POOLS.DAI_WETH, POOLS.USDC_WETH, POOLS.DAI_USDC]);
  console.log('  ✓  DAI/WETH, USDC/WETH, DAI/USDC loaded');

  // ── 2. Refresh a single pool ─────────────────────────────────────────────────
  console.log('\n[2] Refreshing DAI/WETH reserves...');
  await engine.refreshPool(POOLS.DAI_WETH);
  console.log('  ✓  DAI/WETH reserves refreshed');

  // ── 3. Print pool snapshots ──────────────────────────────────────────────────
  console.log('\n[3] Pool snapshots');
  const [daiWeth, usdcWeth] = await Promise.all([
    UniswapV2Pair.fromChain(POOLS.DAI_WETH, client),
    UniswapV2Pair.fromChain(POOLS.USDC_WETH, client),
  ]);
  const dai = daiWeth.token0;
  const usdc = usdcWeth.token0;
  const weth = usdcWeth.token1;

  console.log(`  DAI/WETH  — reserve0: ${formatUnits(daiWeth.reserve0, 18)} DAI`);
  console.log(`              reserve1: ${formatUnits(daiWeth.reserve1, 18)} WETH`);

  const impactBps = daiWeth.getPriceImpactBps(AMOUNT_IN, dai);
  console.log(`  Price impact (1k DAI): ${impactBps} bps`);

  const ethPriceUsdc = usdcWeth.getSpotPrice(weth) / 10n ** 12n;
  console.log(`  ETH price (from pool): $${formatUnits(ethPriceUsdc, 6)}`);

  // ── 4. getQuote ──────────────────────────────────────────────────────────────
  console.log('\n[4] getQuote: 1,000 DAI → USDC');

  if (!FORK_URL) {
    console.log('  -  skipped (FORK_URL not set — start Anvil with ./src/scripts/start_fork.sh)');
  } else {
    const sender = new Address('0x0000000000000000000000000000000000000001');

    try {
      const quote = await engine.getQuote(dai, usdc, AMOUNT_IN, GAS_PRICE_GWEI, sender);

      console.log(`  ✓  Route:          ${quote.route.toString()}`);
      console.log(`     Amount in:      ${formatUnits(quote.amountIn, 18)} DAI`);
      console.log(`     Expected out:   ${formatUnits(quote.expectedOutput, 6)} USDC`);
      console.log(`     Simulated out:  ${formatUnits(quote.simulatedOutput, 6)} USDC`);
      console.log(`     Gas estimate:   ${quote.gasEstimate.toLocaleString()} gas units`);
      console.log(`     Valid (Δ<0.1%): ${quote.isValid ? '✅  yes' : '❌  no'}`);
    } catch (e) {
      if (e instanceof QuoteError) {
        console.log(`  ✗  QuoteError: ${e.message}`);
      } else {
        throw e;
      }
    }
  }

  console.log(`\n${SEP}\n`);
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
