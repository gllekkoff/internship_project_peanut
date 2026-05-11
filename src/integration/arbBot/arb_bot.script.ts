#!/usr/bin/env tsx
import { PRICE_SCALE } from '@/core/core.constants';
import { config } from '@/configs/configs.service';
import { getRiskLimits } from '@/safety/risk.constants';
import { ArbBot } from '@/integration/arbBot/arb_bot.service';
import { resolveToken } from '@/integration/arbBot/arb_bot.utils';

const MIN_SCORE = 40;
const MIN_PROFIT_USD = 0;
const TRADE_SIZE_USD = 6;
const TRADE_SIZE_MIN = 6;
const TRADE_SIZE_MAX = 8;
const MIN_SPREAD_BPS = 2;
const COOLDOWN_MS = 100;

function parseArgs(argv: string[]): {
  tradeSizeUsd: number;
  tradeSizeMin: number | undefined;
  tradeSizeMax: number | undefined;
  cooldownMs: number;
  minSpreadBps: number;
  baseTokenAddress: string | undefined;
  quoteTokenAddress: string | undefined;
} {
  let tradeSizeUsd = TRADE_SIZE_USD;
  let tradeSizeMin: number | undefined = TRADE_SIZE_MIN;
  let tradeSizeMax: number | undefined = TRADE_SIZE_MAX;
  let cooldownMs = COOLDOWN_MS;
  let minSpreadBps = MIN_SPREAD_BPS;
  let baseTokenAddress: string | undefined;
  let quoteTokenAddress: string | undefined;

  const positional: string[] = [];

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--trade-size' && argv[i + 1]) {
      tradeSizeUsd = Number(argv[++i]);
      if (isNaN(tradeSizeUsd) || tradeSizeUsd <= 0)
        throw new Error('--trade-size must be a positive number');
    } else if (argv[i] === '--min-size' && argv[i + 1]) {
      tradeSizeMin = Number(argv[++i]);
      if (isNaN(tradeSizeMin) || tradeSizeMin <= 0)
        throw new Error('--min-size must be a positive number');
    } else if (argv[i] === '--max-size' && argv[i + 1]) {
      tradeSizeMax = Number(argv[++i]);
      if (isNaN(tradeSizeMax) || tradeSizeMax <= 0)
        throw new Error('--max-size must be a positive number');
    } else if (argv[i] === '--cooldown' && argv[i + 1]) {
      cooldownMs = Number(argv[++i]);
      if (isNaN(cooldownMs) || cooldownMs < 0)
        throw new Error('--cooldown must be a non-negative number');
    } else if (argv[i] === '--min-spread' && argv[i + 1]) {
      minSpreadBps = Number(argv[++i]);
      if (isNaN(minSpreadBps) || minSpreadBps < 0)
        throw new Error('--min-spread must be a non-negative number');
    } else if ((argv[i] === '--base-token' || argv[i] === '-B') && argv[i + 1]) {
      baseTokenAddress = resolveToken(argv[++i]!);
    } else if ((argv[i] === '--quote-token' || argv[i] === '-Q') && argv[i + 1]) {
      quoteTokenAddress = resolveToken(argv[++i]!);
    } else if (argv[i] && !argv[i]!.startsWith('-')) {
      positional.push(argv[i]!);
    }
  }

  if (tradeSizeMin !== undefined && tradeSizeMax !== undefined && tradeSizeMin > tradeSizeMax)
    throw new Error('--min-size must be <= --max-size');

  // Positional: first two non-flag args are base and quote tokens.
  // e.g. npm run start:bot -- WETH USDC
  if (positional[0] && !baseTokenAddress) baseTokenAddress = resolveToken(positional[0]);
  if (positional[1] && !quoteTokenAddress) quoteTokenAddress = resolveToken(positional[1]);

  return {
    tradeSizeUsd,
    tradeSizeMin,
    tradeSizeMax,
    cooldownMs,
    minSpreadBps,
    baseTokenAddress,
    quoteTokenAddress,
  };
}

const {
  tradeSizeUsd,
  tradeSizeMin,
  tradeSizeMax,
  cooldownMs,
  minSpreadBps,
  baseTokenAddress,
  quoteTokenAddress,
} = parseArgs(process.argv);

const toScaled = (n: number): bigint => BigInt(Math.round(n * Number(PRICE_SCALE)));

const bot = new ArbBot({
  tradeSizeUsd: toScaled(tradeSizeUsd),
  ...(tradeSizeMin !== undefined ? { tradeSizeMin: toScaled(tradeSizeMin) } : {}),
  ...(tradeSizeMax !== undefined ? { tradeSizeMax: toScaled(tradeSizeMax) } : {}),
  cooldownMs,
  minSpreadBps,
  minScore: MIN_SCORE,
  minProfit: toScaled(MIN_PROFIT_USD),
  simulationMode: !config.production,
  riskLimits: getRiskLimits(config.production),
  baseTokenAddress: baseTokenAddress ?? config.dex.baseToken,
  quoteTokenAddress: quoteTokenAddress ?? config.dex.quoteToken,
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
