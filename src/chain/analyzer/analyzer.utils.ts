import { formatUnits } from 'viem';

const LABEL_WIDTH = 18;

export const row = (label: string, value: string) =>
  console.log(`${label.padEnd(LABEL_WIDTH)}${value}`);

export const sep = (title: string) => console.log(`\n${title}\n${'-'.repeat(title.length)}`);

export const gwei = (v: bigint) => `${formatUnits(v, 9)} gwei`;

export const pct = (used: bigint, limit: bigint) =>
  `${((Number(used) / Number(limit)) * 100).toFixed(2)}%`;

export const ts = (t: bigint) =>
  new Date(Number(t) * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
