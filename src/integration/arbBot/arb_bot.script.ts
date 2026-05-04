#!/usr/bin/env tsx
import { PRICE_SCALE } from '@/core/core.constants';
import { config } from '@/configs/configs.service';
import { getRiskLimits } from '@/safety/risk.constants';
import { ArbBot } from '@/integration/arbBot/arb_bot.service';

function parseArgs(argv: string[]): {
  tradeSizeUsd: number;
  cooldownMs: number;
  minSpreadBps: number;
} {
  let tradeSizeUsd = 1;
  let cooldownMs = 500;
  let minSpreadBps = 0;

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--trade-size' && argv[i + 1]) {
      tradeSizeUsd = Number(argv[++i]);
      if (isNaN(tradeSizeUsd) || tradeSizeUsd <= 0)
        throw new Error('--trade-size must be a positive number');
    } else if (argv[i] === '--cooldown' && argv[i + 1]) {
      cooldownMs = Number(argv[++i]);
      if (isNaN(cooldownMs) || cooldownMs < 0)
        throw new Error('--cooldown must be a non-negative number');
    } else if (argv[i] === '--min-spread' && argv[i + 1]) {
      minSpreadBps = Number(argv[++i]);
      if (isNaN(minSpreadBps) || minSpreadBps < 0)
        throw new Error('--min-spread must be a non-negative number');
    }
  }

  return { tradeSizeUsd, cooldownMs, minSpreadBps };
}

const { tradeSizeUsd, cooldownMs, minSpreadBps } = parseArgs(process.argv);

const bot = new ArbBot({
  tradeSizeUsd: BigInt(Math.round(tradeSizeUsd * Number(PRICE_SCALE))),
  cooldownMs,
  minSpreadBps,
  minScore: 0,
  simulationMode: !config.production,
  riskLimits: getRiskLimits(config.production),
  baseTokenAddress: config.dex.baseToken,
  quoteTokenAddress: config.dex.quoteToken,
});

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) {
    process.exit(1);
  }
  shuttingDown = true;
  console.log(`\nReceived ${signal} — shutting down gracefully (press again to force exit)`);
  void bot.stop();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

await bot.run();
process.exit(0);
