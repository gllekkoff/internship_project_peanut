import 'dotenv/config';
import { arbitrum, mainnet, sepolia } from 'viem/chains';
import type { Chain } from 'viem';
import { makeLogger } from '@/core/core.logger';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const SUPPORTED_CHAINS: Record<number, Chain> = {
  1: mainnet,
  11155111: sepolia,
  42161: arbitrum,
};

function resolveChain(chainId: number): Chain {
  const chain = SUPPORTED_CHAINS[chainId];
  if (!chain)
    throw new Error(
      `Unsupported CHAIN_ID: ${chainId}. Supported: ${Object.keys(SUPPORTED_CHAINS).join(', ')}`,
    );
  return chain;
}

type RunMode = 'sim' | 'paper' | 'live';

function parseRunMode(): RunMode {
  const raw = requireEnv('RUN_MODE').toLowerCase();
  if (raw === 'sim' || raw === 'paper' || raw === 'live') return raw;
  throw new Error(`Invalid RUN_MODE "${raw}". Must be: sim | paper | live`);
}

const runMode = parseRunMode();
/** true only in live mode — gates real on-chain txs and CEX order submission. */
const production = runMode === 'live';
/** true in sim mode — uses Binance testnet credentials and endpoint. */
const binanceSandbox = runMode === 'sim';
const chainId = Number(requireEnv('CHAIN_ID'));

const log = makeLogger('Config');
if (runMode === 'live') {
  log.warn('LIVE — real on-chain txs + real Binance orders');
} else if (runMode === 'paper') {
  log.info('Paper trading — no trades, live Binance market data');
} else {
  log.info('Simulation — no trades, Binance testnet');
}

export const chain = resolveChain(chainId);

export const config = {
  runMode,
  production,

  dex: {
    router: requireEnv('ROUTER') as `0x${string}`,
    pool: requireEnv('POOL') as `0x${string}`,
    /** On-chain address of the base (first) token in the pool, e.g. WETH. */
    baseToken: requireEnv('BASE_TOKEN') as `0x${string}`,
    /** On-chain address of the quote (second) token in the pool, e.g. USDC. */
    quoteToken: requireEnv('QUOTE_TOKEN') as `0x${string}`,
  },

  chain: {
    id: chainId,
    viemChain: chain,
    rpcUrl: requireEnv('MAINNET_RPC_URL'),
    wsUrl: requireEnv('MAINNET_WS_URL'),
    privateKey: requireEnv('PRIVATE_KEY') as `0x${string}`,
    sepoliaRpcUrl: requireEnv('SEPOLIA_RPC_URL'),
    port: Number(requireEnv('PORT')),
  },

  fork: {
    rpcUrl: requireEnv('FORK_RPC_URL'),
    wsUrl: requireEnv('FORK_WS_URL'),
  },

  flashbotsRpcUrl: process.env['FLASHBOTS_RPC_URL'] ?? '',

  telegram: {
    botToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    chatId: requireEnv('TELEGRAM_CHAT_ID'),
  },

  binance: {
    apiKey: binanceSandbox ? requireEnv('BINANCE_TESTNET_API_KEY') : requireEnv('BINANCE_API_KEY'),
    secret: binanceSandbox ? requireEnv('BINANCE_TESTNET_SECRET') : requireEnv('BINANCE_SECRET'),
    sandbox: binanceSandbox,
    /** 0.1% taker fee on live Binance; testnet charges nothing. */
    cexFeeBps: binanceSandbox ? 0 : 10,
    options: {
      defaultType: 'spot' as const,
    },
    enableRateLimit: true,
  },
} as const;
