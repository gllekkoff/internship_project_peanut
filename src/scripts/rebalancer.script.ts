#!/usr/bin/env tsx
/**
 * Inventory rebalancer CLI.
 * Usage:
 *   npx tsx src/scripts/rebalancer.script.ts --check
 *   npx tsx src/scripts/rebalancer.script.ts --plan ETH
 */
import { PRICE_SCALE } from '@/exchange/cexClient/exchange.constants';
import { InventoryTracker } from '@/inventory/tracker/tracker.service';
import { Venue } from '@/inventory/tracker/tracker.interfaces';
import { RebalancePlanner } from '@/inventory/rebalancer/rebalancer.service';
import type { TransferPlan } from '@/inventory/rebalancer/rebalancer.interfaces';

// ── Demo data (mirrors the CLI example in the spec) ───────────────────────────

const tracker = new InventoryTracker([Venue.BINANCE, Venue.WALLET]);

tracker.updateFromCex(Venue.BINANCE, {
  ETH: { free: 200_000_000n, locked: 0n, total: 200_000_000n }, // 2.0 ETH
  USDT: { free: 1_800_000_000_000n, locked: 0n, total: 1_800_000_000_000n }, // 18,000 USDT
});

tracker.updateFromWallet(Venue.WALLET, {
  ETH: 800_000_000n, // 8.0 ETH
  USDT: 1_200_000_000_000n, // 12,000 USDT
});

const planner = new RebalancePlanner(tracker);

// ── Formatting helpers ─────────────────────────────────────────────────────────

const SEP = '═'.repeat(43);
const LINE = '─'.repeat(43);

function toFloat(v: bigint, decimals = 2): string {
  return (Number(v) / Number(PRICE_SCALE)).toFixed(decimals);
}

function pct(n: number): string {
  return `${Math.round(n)}%`;
}

// ── --check ────────────────────────────────────────────────────────────────────

function runCheck(): void {
  console.log('\nInventory Skew Report');
  console.log(SEP);

  for (const check of planner.checkAll()) {
    const skew = tracker.skew(check.asset);
    console.log(`\nAsset: ${check.asset}`);

    for (const [venue, vs] of Object.entries(skew.venues)) {
      const sign = vs.deviationPct >= 0 ? '+' : '';
      console.log(
        `  ${venue.padEnd(8)}: ${toFloat(vs.amount)} ${check.asset}`.padEnd(32) +
          `(${pct(vs.pct)})`.padEnd(8) +
          `← deviation: ${sign}${Math.round(vs.deviationPct)}%`,
      );
    }

    const status = check.needsRebalance
      ? '⚠️  NEEDS REBALANCE'
      : `✅  OK (deviation: ${check.maxDeviationPct.toFixed(1)}%)`;
    console.log(`  Status: ${status}`);
  }

  console.log(`\n${SEP}\n`);
}

// ── --plan <ASSET> ─────────────────────────────────────────────────────────────

function runPlan(asset: string): void {
  const plans = planner.plan(asset);

  console.log(`\nRebalance Plan: ${asset}`);
  console.log(LINE);

  if (plans.length === 0) {
    console.log('  No rebalance needed.\n');
    return;
  }

  plans.forEach((p: TransferPlan, i: number) => {
    const skewBefore = tracker.skew(p.asset);
    const total = skewBefore.total;

    // Project balances after transfer for display.
    const projected: Record<string, bigint> = {};
    for (const [venue, vs] of Object.entries(skewBefore.venues)) {
      projected[venue] = vs.amount;
    }
    projected[p.fromVenue] = (projected[p.fromVenue] ?? 0n) - p.amount;
    projected[p.toVenue] = (projected[p.toVenue] ?? 0n) + p.netAmount;

    console.log(`Transfer ${i + 1}:`);
    console.log(`  From:     ${p.fromVenue}`);
    console.log(`  To:       ${p.toVenue}`);
    console.log(`  Amount:   ${toFloat(p.amount, 4)} ${p.asset}`);
    console.log(`  Fee:      ${toFloat(p.estimatedFee, 4)} ${p.asset}`);
    console.log(`  ETA:      ~${p.estimatedTimeMin} min`);
    console.log();
    console.log(`  Result:`);
    for (const [venue, amount] of Object.entries(projected)) {
      const projPct = total > 0n ? Math.round((Number(amount) / Number(total)) * 100) : 0;
      console.log(`    ${venue.padEnd(8)}: ${toFloat(amount)} ${p.asset} (${projPct}%)`);
    }
    console.log();
  });

  const cost = planner.estimateCost(plans);
  const totalFees = plans.reduce((sum, p) => sum + p.estimatedFee, 0n);
  console.log(`Estimated total cost: ${toFloat(totalFees, 4)} ${asset}`);
  console.log(`Estimated time:       ~${cost.totalTimeMin} min (parallel)\n`);
}

// ── Dispatch ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--check')) {
  runCheck();
} else if (args.includes('--plan')) {
  const asset = args[args.indexOf('--plan') + 1];
  if (!asset) {
    console.error('Usage: --plan <ASSET>  e.g. --plan ETH');
    process.exit(1);
  }
  runPlan(asset.toUpperCase());
} else {
  console.log('Usage:');
  console.log('  --check         Show skew report for all assets');
  console.log('  --plan <ASSET>  Show rebalance plan for a specific asset');
}
