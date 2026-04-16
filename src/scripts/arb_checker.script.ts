#!/usr/bin/env tsx
/**
 * Arb checker CLI — live DEX vs CEX price comparison via ArbChecker.
 * Fetches real pool data from mainnet and real order book from Binance testnet.
 *
 * Usage:
 *   npx tsx src/scripts/arb_checker.script.ts --pair ETH/USDT --size 2.0
 *
 * Required env: MAINNET_RPC_URL, PRIVATE_KEY
 * Optional env: BINANCE_TESTNET_API_KEY, BINANCE_TESTNET_SECRET (falls back to public order book)
 */
import { config } from '@/configs/configs.service';
import { Address } from '@/core/core.types';
import { ChainClient } from '@/chain/chain.client';
import { UniswapV2Pair } from '@/pricing/uniswap-v2/uniswap-v2.service';
import { PricingEngine } from '@/pricing/engine/engine.service';
import { ExchangeClient } from '@/exchange/cexClient/exchange.client';
import { PRICE_SCALE } from '@/exchange/cexClient/exchange.constants';
import { InventoryTracker } from '@/inventory/tracker/tracker.service';
import { PnLEngine } from '@/inventory/pnl/pnl.service';
import { Venue } from '@/inventory/tracker/tracker.interfaces';
import { ArbChecker } from '@/integration/arbChecker/arbChecker.service';
import type { ArbCheckResult } from '@/integration/arbChecker/arbChecker.interfaces';

// USDC/WETH pool on Uniswap V2 mainnet — used for ETH/USDT pair approximation.
const USDC_WETH_POOL = new Address('0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc');

const SEP = '═'.repeat(43);
const LINE = '─'.repeat(24);

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmtUsd(v: bigint, decimals = 2): string {
  const n = Number(v) / Number(PRICE_SCALE);
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtNum(n: number, decimals = 1): string {
  return n.toFixed(decimals);
}

// ── Output ────────────────────────────────────────────────────────────────────

function printResult(r: ArbCheckResult, size: number, baseAsset: string): void {
  const d = r.details;
  const profitable = r.estimatedNetPnlBps > 0;
  const pnlIcon = profitable ? '✅' : '❌';
  const pnlLabel = profitable ? 'PROFITABLE' : 'NOT PROFITABLE';
  const verdict = r.executable
    ? 'EXECUTE — opportunity within limits'
    : !profitable
      ? 'SKIP — costs exceed gap'
      : 'SKIP — insufficient inventory';

  console.log(`\n${SEP}`);
  console.log(`  ARB CHECK: ${r.pair} (size: ${size} ${baseAsset})`);
  console.log(SEP);

  console.log('\nPrices:');
  console.log(`  Uniswap V2:  $${fmtUsd(r.dexPrice)} (buy ${size} ${baseAsset})`);
  console.log(`  Binance bid: $${fmtUsd(r.cexBid)}`);

  const gapUsd = r.cexBid - r.dexPrice;
  console.log(`\nGap: $${fmtUsd(gapUsd)} (${fmtNum(r.gapBps)} bps)`);

  const gasCostBps =
    d.gasCostUsd > 0
      ? (d.gasCostUsd / ((Number(r.dexPrice) / Number(PRICE_SCALE)) * size)) * 10_000
      : 0;

  console.log('\nCosts:');
  console.log(`  DEX fee:          ${fmtNum(d.dexFeeBps, 1)} bps`);
  console.log(`  DEX price impact: ${fmtNum(d.dexPriceImpactBps, 1)} bps`);
  console.log(`  CEX fee:          ${fmtNum(d.cexFeeBps, 1)} bps`);
  console.log(`  CEX slippage:     ${fmtNum(d.cexSlippageBps, 1)} bps`);
  console.log(`  Gas:              $${fmtNum(d.gasCostUsd, 2)} (${fmtNum(gasCostBps, 1)} bps)`);
  console.log(`  ${LINE}`);
  console.log(`  Total costs:      ${fmtNum(d.totalCostBps, 1)} bps`);

  console.log(`\nNet PnL estimate: ${fmtNum(r.estimatedNetPnlBps, 1)} bps ${pnlIcon} ${pnlLabel}`);

  console.log('\nInventory:');
  console.log(`  ${r.inventoryOk ? '✅ Sufficient' : '❌ Insufficient — check balances'}`);

  console.log(`\nVerdict: ${verdict}`);
  console.log(`${SEP}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const pairIdx = args.indexOf('--pair');
  const sizeIdx = args.indexOf('--size');

  const pair = (pairIdx !== -1 ? args[pairIdx + 1] : 'ETH/USDT')!.toUpperCase();
  const size = sizeIdx !== -1 ? parseFloat(args[sizeIdx + 1] ?? '1.0') : 2.0;

  if (!pair.includes('/')) {
    console.error('Usage: --pair ETH/USDT --size 2.0');
    process.exit(1);
  }

  const [baseAsset] = pair.split('/') as [string, string];

  // ── Clients ─────────────────────────────────────────────────────────────────
  const chainClient = new ChainClient([config.chain.mainnetRpcUrl]);
  const pricingEngine = new PricingEngine(
    chainClient,
    'http://127.0.0.1:8545',
    'ws://127.0.0.1:8546',
  );

  const exchangeClient = new ExchangeClient({
    apiKey: config.binance.apiKey ?? '',
    secret: config.binance.secret ?? '',
    sandbox: config.binance.sandbox,
    options: { ...config.binance.options },
    enableRateLimit: config.binance.enableRateLimit,
  });

  // ── Load pool ────────────────────────────────────────────────────────────────
  console.log(`\nLoading pool and order book for ${pair}...`);
  const [pool] = await Promise.all([
    UniswapV2Pair.fromChain(USDC_WETH_POOL, chainClient),
    pricingEngine.loadPools([USDC_WETH_POOL]),
  ]);

  // ── Load real balances from Binance ──────────────────────────────────────────
  let cexBalances: Record<string, { free: bigint; locked: bigint; total: bigint }> = {};
  try {
    await exchangeClient.connect();
    cexBalances = await exchangeClient.fetchBalance();
  } catch {
    console.warn('[warn] Could not fetch Binance balances — using zero inventory');
  }

  const tracker = new InventoryTracker([Venue.BINANCE, Venue.WALLET]);
  tracker.updateFromCex(Venue.BINANCE, cexBalances);

  const pnl = new PnLEngine();

  // ── Trade size in PRICE_SCALE ─────────────────────────────────────────────────
  const tradeSize = BigInt(Math.round(size * Number(PRICE_SCALE)));

  // Pool tokens may differ from the CEX pair symbols (e.g. WETH vs ETH, USDC vs USDT).
  // Identify which pool token is the base by matching the CEX base symbol prefix.
  const poolBase = pool.token0.symbol.startsWith(baseAsset)
    ? pool.token0.symbol
    : pool.token1.symbol.startsWith(baseAsset)
      ? pool.token1.symbol
      : pool.token1.symbol; // fallback: treat token1 as base (WETH in USDC/WETH)
  const poolQuote = poolBase === pool.token0.symbol ? pool.token1.symbol : pool.token0.symbol;

  // ── ArbChecker ───────────────────────────────────────────────────────────────
  const checker = new ArbChecker(pricingEngine, exchangeClient, tracker, pnl, [
    {
      pair,
      baseAsset: poolBase,
      quoteAsset: poolQuote,
      cexSymbol: pair,
      pool,
      tradeSize,
      dexFeeBps: Number(pool.feeBps),
      cexFeeBps: 10,
      gasCostUsd: 5,
      baseVenue: Venue.BINANCE,
      quoteVenue: Venue.BINANCE,
    },
  ]);

  const result = await checker.check(pair);
  printResult(result, size, baseAsset);
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
