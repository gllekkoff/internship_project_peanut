#!/usr/bin/env tsx
/**
 * Portfolio snapshot across Binance testnet + wallet.
 * Usage: npx tsx src/scripts/portfolio.script.ts
 *
 * Required env: MAINNET_RPC_URL, PRIVATE_KEY
 * Optional env: BINANCE_TESTNET_API_KEY, BINANCE_TESTNET_SECRET
 */
import { config } from '@/configs/configs.service';
import { Address } from '@/core/core.types';
import { WalletManager } from '@/core/wallet.service';
import { ChainClient } from '@/chain/chain.client';
import { ExchangeClient } from '@/exchange/cexClient/exchange.client';
import { PRICE_SCALE } from '@/core/core.constants';
import { InventoryTracker } from '@/inventory/tracker/tracker.service';
import { Venue } from '@/inventory/tracker/tracker.interfaces';
import { RebalancePlanner } from '@/inventory/rebalancer/rebalancer.service';
import { BINANCE_PROFILE } from '@/venues/binance/binance.profile';

const SEP = '═'.repeat(50);
const LINE = '─'.repeat(50);

function fmtAmt(v: bigint, decimals = 4): string {
  return (Number(v) / Number(PRICE_SCALE)).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

// ── Clients ───────────────────────────────────────────────────────────────────
const chainClient = new ChainClient([config.chain.mainnetRpcUrl]);
const exchangeClient = new ExchangeClient(config.binance, BINANCE_PROFILE);

const wallet = WalletManager.from_env('PRIVATE_KEY');
const walletAddress = new Address(wallet.getAddress());

console.log(`\n${SEP}`);
console.log('  Portfolio Snapshot');
console.log(SEP);
console.log(`  Wallet: ${walletAddress.value}`);
console.log(`  Time:   ${new Date().toISOString()}`);

// ── Fetch in parallel ─────────────────────────────────────────────────────────
console.log('\nFetching balances...');

let cexBalances: Record<string, { free: bigint; locked: bigint; total: bigint }> = {};
let walletEth = 0n;

await Promise.all([
  exchangeClient
    .connect()
    .then(() => exchangeClient.fetchBalance())
    .then((b) => {
      cexBalances = b;
    })
    .catch((e) => console.warn(`  [warn] Binance: ${e instanceof Error ? e.message : String(e)}`)),

  chainClient
    .getBalance(walletAddress)
    .then((b) => {
      // getBalance returns TokenAmount with .raw in wei (1e18); convert to PRICE_SCALE (1e8).
      walletEth = b.raw / 10n ** 10n;
    })
    .catch((e) =>
      console.warn(`  [warn] Wallet ETH: ${e instanceof Error ? e.message : String(e)}`),
    ),
]);

// ── Build tracker snapshot ────────────────────────────────────────────────────
const tracker = new InventoryTracker([Venue.BINANCE, Venue.WALLET]);
tracker.updateFromCex(Venue.BINANCE, cexBalances);
tracker.updateFromWallet(Venue.WALLET, { ETH: walletEth });

const snap = tracker.snapshot();

// ── Print Binance ─────────────────────────────────────────────────────────────
console.log(`\n${LINE}`);
console.log('  Binance Testnet');
console.log(LINE);

const binanceAssets = snap.venues[Venue.BINANCE] ?? {};
const nonZero = Object.entries(binanceAssets).filter(([, v]) => v.total > 0n);

if (nonZero.length === 0) {
  console.log('  (no balances)');
} else {
  for (const [asset, v] of nonZero) {
    const locked = v.locked > 0n ? ` (${fmtAmt(v.locked)} locked)` : '';
    console.log(`  ${asset.padEnd(8)} ${fmtAmt(v.free).padStart(16)} free${locked}`);
  }
}

// ── Print Wallet ──────────────────────────────────────────────────────────────
console.log(`\n${LINE}`);
console.log('  Wallet (mainnet)');
console.log(LINE);

if (walletEth === 0n) {
  console.log('  ETH       0.0000');
} else {
  console.log(`  ETH      ${fmtAmt(walletEth).padStart(16)}`);
}

// ── Skew report ───────────────────────────────────────────────────────────────
const planner = new RebalancePlanner(tracker, BINANCE_PROFILE);
const checks = planner.checkAll();
const needsRebalance = checks.filter((c) => c.needsRebalance);

console.log(`\n${LINE}`);
console.log('  Skew');
console.log(LINE);

if (checks.length === 0) {
  console.log('  No assets tracked');
} else {
  for (const c of checks) {
    const flag = c.needsRebalance ? '⚠️ ' : '✅ ';
    console.log(`  ${flag} ${c.asset.padEnd(6)} max deviation: ${c.maxDeviationPct.toFixed(1)}%`);
  }
}

if (needsRebalance.length > 0) {
  console.log(`\n  ⚠️  ${needsRebalance.map((c) => c.asset).join(', ')} need rebalancing`);
}

console.log(`\n${SEP}\n`);
