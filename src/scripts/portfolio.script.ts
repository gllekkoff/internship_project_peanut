#!/usr/bin/env tsx
/**
 * Portfolio snapshot across Binance + wallet.
 * Usage: npx tsx src/scripts/portfolio.script.ts
 *
 * Wallet tokens are read from ARBITRUM_TOKENS in src/core/tokens.constants.ts.
 * Required env: MAINNET_RPC_URL, PRIVATE_KEY
 */
import { erc20Abi } from 'viem';
import type { Hex } from 'viem';
import { config, chain as viemChain } from '@/configs/configs.service';
import { Address } from '@/core/core.types';
import { WalletManager } from '@/core/wallet.service';
import { ChainClient } from '@/chain/chain.client';
import { ExchangeClient } from '@/exchange/cexClient/exchange.client';
import { PRICE_SCALE } from '@/core/core.constants';
import { ARBITRUM_TOKENS } from '@/core/tokens.constants';
import { InventoryTracker } from '@/inventory/tracker/tracker.service';
import { Venue } from '@/inventory/tracker/tracker.interfaces';
import { RebalancePlanner } from '@/inventory/rebalancer/rebalancer.service';
import { getBinanceProfile } from '@/venues/binance/binance.profile';

const SEP = '═'.repeat(50);
const LINE = '─'.repeat(50);

function fmtAmt(v: bigint, decimals = 4): string {
  return (Number(v) / Number(PRICE_SCALE)).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

const chainClient = new ChainClient([config.chain.rpcUrl], 30, 3, viemChain);
const exchangeClient = new ExchangeClient(config.binance, getBinanceProfile(config.production));
const wallet = WalletManager.from_env('PRIVATE_KEY');
const walletAddress = new Address(wallet.getAddress());

console.log(`\n${SEP}`);
console.log('  Portfolio Snapshot');
console.log(SEP);
console.log(`  Wallet: ${walletAddress.value}`);
console.log(`  Time:   ${new Date().toISOString()}`);
console.log('\nFetching balances...');

// ── Fetch ERC-20 balances for all known tokens ────────────────────────────────

const holder = walletAddress.value as Hex;

const tokenResults = await Promise.all(
  Object.entries(ARBITRUM_TOKENS).map(async ([symbol, { address, decimals }]) => {
    try {
      const raw = (await chainClient.readContract({
        address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [holder],
      })) as bigint;
      const scaled = (raw * PRICE_SCALE) / 10n ** BigInt(decimals);
      return { symbol, scaled };
    } catch {
      return { symbol, scaled: 0n };
    }
  }),
);

const walletTokens = tokenResults.filter((t) => t.scaled > 0n);

// ── Fetch CEX balances and native ETH in parallel ────────────────────────────

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
      walletEth = b.raw / 10n ** 10n;
    })
    .catch((e) =>
      console.warn(`  [warn] Wallet ETH: ${e instanceof Error ? e.message : String(e)}`),
    ),
]);

// ── Build tracker ─────────────────────────────────────────────────────────────

const tracker = new InventoryTracker([Venue.BINANCE, Venue.WALLET]);
tracker.updateFromCex(Venue.BINANCE, cexBalances);
tracker.updateFromWallet(Venue.WALLET, {
  ETH: walletEth,
  ...Object.fromEntries(walletTokens.map((t) => [t.symbol, t.scaled])),
});

const snap = tracker.snapshot();

// ── Print Binance ─────────────────────────────────────────────────────────────

console.log(`\n${LINE}`);
console.log(`  Binance (${config.binance.sandbox ? 'testnet' : 'mainnet'})`);
console.log(LINE);

const nonZeroCex = Object.entries(snap.venues[Venue.BINANCE] ?? {}).filter(([, v]) => v.total > 0n);
if (nonZeroCex.length === 0) {
  console.log('  (no balances)');
} else {
  for (const [asset, v] of nonZeroCex) {
    const locked = v.locked > 0n ? ` (${fmtAmt(v.locked)} locked)` : '';
    console.log(`  ${asset.padEnd(8)} ${fmtAmt(v.free).padStart(16)} free${locked}`);
  }
}

// ── Print Wallet ──────────────────────────────────────────────────────────────

console.log(`\n${LINE}`);
console.log('  Wallet (Arbitrum)');
console.log(LINE);
console.log(`  ${'ETH'.padEnd(8)} ${fmtAmt(walletEth).padStart(16)}  (gas)`);
for (const t of walletTokens) {
  console.log(`  ${t.symbol.padEnd(8)} ${fmtAmt(t.scaled).padStart(16)}`);
}
if (walletTokens.length === 0 && walletEth === 0n) {
  console.log('  (no balances)');
}

// ── Skew report ───────────────────────────────────────────────────────────────

const planner = new RebalancePlanner(tracker, getBinanceProfile(config.production));
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
