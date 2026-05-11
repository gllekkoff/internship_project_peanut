import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const LOG_DIR = join(process.cwd(), 'logs');
mkdirSync(LOG_DIR, { recursive: true });

function logFilePath(): string {
  const d = new Date();
  const date =
    `${d.getFullYear()}` +
    `${String(d.getMonth() + 1).padStart(2, '0')}` +
    `${String(d.getDate()).padStart(2, '0')}`;
  return join(LOG_DIR, `bot_${date}.log`);
}

function writeLine(line: string): void {
  appendFileSync(logFilePath(), line + '\n', 'utf8');
}

function ts(): string {
  return new Date().toLocaleString('sv').replace('T', ' ');
}

const DEBUG_ENABLED = process.env['LOG_LEVEL'] === 'debug';

export type Logger = {
  debug: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

/** Returns a namespaced logger that writes every line to console and a daily log file. */
export function makeLogger(module: string): Logger {
  const tag = `[${module}]`;
  const emit = (level: string, consoleFn: (s: string) => void, msg: string): void => {
    const line = `${ts()} ${level} ${tag} ${msg}`;
    consoleFn(line);
    writeLine(line);
  };
  return {
    debug: (msg) => {
      if (DEBUG_ENABLED) emit('DEBUG', console.log, msg);
    },
    info: (msg) => emit('INFO ', console.log, msg),
    warn: (msg) => emit('WARN ', console.warn, msg),
    error: (msg) => emit('ERROR', console.error, msg),
  };
}

/** Fields for a structured trade log line. */
export interface TradeLogFields {
  pair: string;
  direction: string;
  /** Trade size in base asset (e.g. ETH). */
  size: number;
  spreadBps: number;
  /** Realised net PnL in USD. */
  pnlUsd: number;
  state: string;
}

/**
 * Emits a pipe-delimited TRADE record via the provided logger.
 * Produces machine-parseable lines: TRADE | pair=… | direction=… | …
 */
export function logTrade(log: Logger, fields: TradeLogFields): void {
  log.info(
    `TRADE | pair=${fields.pair} | direction=${fields.direction}` +
      ` | size=${fields.size.toFixed(4)} | spread=${fields.spreadBps.toFixed(1)}bps` +
      ` | pnl=${fields.pnlUsd.toFixed(2)} | state=${fields.state}`,
  );
}

/**
 * Emits a pipe-delimited ERROR record with structured context via the provided logger.
 * Produces machine-parseable lines: ERROR | <message> | key=value | …
 */
export function logError(log: Logger, error: string, context: Record<string, unknown>): void {
  const ctx = Object.entries(context)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' | ');
  log.error(`ERROR | ${error}${ctx ? ` | ${ctx}` : ''}`);
}
