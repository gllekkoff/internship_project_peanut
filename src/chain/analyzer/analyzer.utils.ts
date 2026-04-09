import { formatUnits } from 'viem';

const LABEL_WIDTH = 18;

/** Prints a two-column label/value row to stdout. */
export const row = (label: string, value: string) =>
  console.log(`${label.padEnd(LABEL_WIDTH)}${value}`);

/** Prints a titled separator line to stdout. */
export const sep = (title: string) => console.log(`\n${title}\n${'-'.repeat(title.length)}`);

/** Formats a bigint wei value as a gwei string. */
export const gwei = (v: bigint) => `${formatUnits(v, 9)} gwei`;

/** Computes the percentage of `used` out of `limit`, formatted to 2 decimal places. */
export const pct = (used: bigint, limit: bigint) =>
  `${((Number(used) / Number(limit)) * 100).toFixed(2)}%`;

/** Formats a unix timestamp bigint as a human-readable UTC string. */
export const ts = (t: bigint) =>
  new Date(Number(t) * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
