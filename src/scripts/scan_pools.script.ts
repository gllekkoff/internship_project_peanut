#!/usr/bin/env tsx
/**
 * Scans Uniswap V2 for TOKEN/QUOTE pools across a configurable token list.
 * Filters by on-chain liquidity and Binance order book depth, then saves results to scan_results.json.
 *
 * Usage:
 *   npx tsx src/scripts/scan_pools.script.ts
 *
 * Required env: CHAIN_ID, MAINNET_RPC_URL
 * Optional env:
 *   SCAN_QUOTE_TOKEN    — quote token address (default: WETH on Arbitrum)
 *   SCAN_QUOTE_DECIMALS — decimals for a non-WETH quote token (default: 18)
 *
 * Thresholds (edit at top of file):
 *   MIN_QUOTE_RESERVE      — minimum quote-side reserves to pass (default: 1.0 WETH)
 *   MIN_BINANCE_DEPTH_USDT — minimum Binance order book depth within 0.5% of mid (default: $5 000)
 */
import 'dotenv/config';
import {
  createPublicClient,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseAbi,
  zeroAddress,
} from 'viem';
import type { Address } from 'viem';
import { arbitrum, mainnet, sepolia } from 'viem/chains';
import type { Chain } from 'viem';
import fs from 'node:fs/promises';

// ── tunable thresholds ──────────────────────────────────────────────────────
const MIN_QUOTE_RESERVE = 1.0;
const MIN_BINANCE_DEPTH_USDT = 5_000;
const DEPTH_WINDOW_PCT = 0.005;
const BINANCE_DEPTH_LIMIT = 1000;
const OUTPUT_FILE = 'scan_results.json';
// ────────────────────────────────────────────────────────────────────────────

const WETH: Address = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const QUOTE_TOKEN: Address = (process.env['SCAN_QUOTE_TOKEN'] as Address | undefined) ?? WETH;
const QUOTE_DECIMALS =
  QUOTE_TOKEN.toLowerCase() === WETH.toLowerCase()
    ? 18
    : Number(process.env['SCAN_QUOTE_DECIMALS'] ?? '18');

const FACTORY_ABI = parseAbi([
  'function getPair(address tokenA, address tokenB) view returns (address pair)',
]);

const PAIR_ABI = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
]);

const KNOWN_TOKENS: TokenEntry[] = [
  {
    symbol: 'ARB',
    name: 'Arbitrum',
    address: '0x912CE59144191C1204E64559FE8253a0e49E6548',
    decimals: 18,
  },
  {
    symbol: 'WETH',
    name: 'Wrapped Ether',
    address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    decimals: 18,
  },
  {
    symbol: 'WBTC',
    name: 'Wrapped BTC',
    address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
    decimals: 8,
  },

  {
    symbol: 'USDC',
    name: 'USD Coin',
    address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    decimals: 6,
  },
  {
    symbol: 'USDC',
    name: 'Bridged USDC / USDC.e',
    address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
    decimals: 6,
  },
  {
    symbol: 'USDT',
    name: 'Tether USD',
    address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    decimals: 6,
  },
  {
    symbol: 'DAI',
    name: 'Dai Stablecoin',
    address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
    decimals: 18,
  },
  {
    symbol: 'FRAX',
    name: 'Frax',
    address: '0x17FC002b466eEc40DaE837Fc4bE5c67993ddBd6F',
    decimals: 18,
  },

  {
    symbol: 'LINK',
    name: 'ChainLink Token',
    address: '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4',
    decimals: 18,
  },
  {
    symbol: 'UNI',
    name: 'Uniswap',
    address: '0xfa7f8980b0f1e64a2062791cc3b0871572f1f7f0',
    decimals: 18,
  },
  {
    symbol: 'AAVE',
    name: 'Aave Token',
    address: '0xba5DdD1f9d7F570dc94a51479a000E3BCE967196',
    decimals: 18,
  },
  {
    symbol: 'CRV',
    name: 'Curve DAO Token',
    address: '0x11cdb42b0EB46D95f990BeDD4695A6e3fA034978',
    decimals: 18,
  },
  {
    symbol: 'BAL',
    name: 'Balancer',
    address: '0x040d1EdC9569d4BAb2D15287Dc5A4F10F56a56B8',
    decimals: 18,
  },
  {
    symbol: 'COMP',
    name: 'Compound',
    address: '0x354A6dA3fcde098F8389cad84b0182725c6C91dE',
    decimals: 18,
  },
  {
    symbol: 'GRT',
    name: 'Graph Token',
    address: '0x23A941036Ae778Ac51Ab04CEa08Ed6e2FE103614',
    decimals: 18,
  },
  {
    symbol: 'SUSHI',
    name: 'SushiToken',
    address: '0xd4d42F0b6DEF4cE0383636770eF773390d85c61A',
    decimals: 18,
  },
  {
    symbol: 'YFI',
    name: 'yearn.finance',
    address: '0x82e3A8F066a6989666b031d916c43672085b1582',
    decimals: 18,
  },
  {
    symbol: 'KNC',
    name: 'Kyber Network Crystal',
    address: '0xe4Dddfe67E7164B0FE14E218D80dc4C08EDc01cB',
    decimals: 18,
  },
  {
    symbol: 'UMA',
    name: 'UMA Voting Token',
    address: '0xd693Ec944A85eeca4247eC1c3b130DCa9B0C3b22',
    decimals: 18,
  },

  {
    symbol: 'GMX',
    name: 'GMX',
    address: '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a',
    decimals: 18,
  },
  {
    symbol: 'MAGIC',
    name: 'MAGIC',
    address: '0x539bdE0d7Dbd336b79148AA742883198BBF60342',
    decimals: 18,
  },
  {
    symbol: 'RDNT',
    name: 'Radiant',
    address: '0x3082CC23568eA640225c2467653dB90e9250AaA0',
    decimals: 18,
  },
  {
    symbol: 'PENDLE',
    name: 'Pendle',
    address: '0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8',
    decimals: 18,
  },
  {
    symbol: 'LDO',
    name: 'Lido DAO Token',
    address: '0x13Ad51beC8A5e4b18E718b90Bf4d30A3fE35fC8B',
    decimals: 18,
  },
  {
    symbol: 'JOE',
    name: 'JoeToken',
    address: '0x371c7ec6D8039FF7933A2Aa28eb827FFE1F52f07',
    decimals: 18,
  },

  {
    symbol: 'STG',
    name: 'StargateToken',
    address: '0x6694340fc020c5E6b96567843Da2DF01b2CE1eb6',
    decimals: 18,
  },
  {
    symbol: 'SYN',
    name: 'Synapse',
    address: '0x080F6AEd32Fc474DD5717105Dba5ea57268F46eb',
    decimals: 18,
  },
  {
    symbol: 'FXS',
    name: 'Frax Share',
    address: '0x9d2f299715D94d8A7E6F5Eaa8E654E8c74a988A7',
    decimals: 18,
  },
];

interface TokenEntry {
  readonly symbol: string;
  readonly name: string;
  readonly address: string;
  readonly decimals: number;
}

interface PoolResult {
  readonly symbol: string;
  readonly tokenAddress: string;
  readonly tokenDecimals: number;
  readonly pairAddress: string;
  readonly reserveQuote: string;
  readonly reserveToken: string;
  readonly quoteReserveFormatted: string;
  readonly tokenReserveFormatted: string;
  readonly impliedPrice: string;
  readonly blockTimestampLast: number;
  readonly binanceSymbol: string | null;
  readonly binanceDepth: BinanceDepthResult | null;
  readonly warnings: string[];
}

interface BinanceDepthResult {
  readonly midPrice: number;
  readonly bidDepthUsdt: number;
  readonly askDepthUsdt: number;
  readonly windowPct: number;
}

interface BinanceSymbol {
  readonly symbol: string;
  readonly status: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly isSpotTradingAllowed?: boolean;
  readonly permissions?: string[];
  readonly permissionSets?: string[][];
}

interface BinanceDepthRaw {
  readonly bids: [string, string][];
  readonly asks: [string, string][];
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function resolveChain(id: number): Chain {
  if (id === arbitrum.id) return arbitrum;
  if (id === mainnet.id) return mainnet;
  if (id === sepolia.id) return sepolia;
  throw new Error(`Unsupported CHAIN_ID: ${id}`);
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { 'user-agent': 'arb-pool-scanner/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json() as Promise<T>;
}

async function fetchBinanceSpotSymbols(): Promise<BinanceSymbol[]> {
  const data = await fetchJson<{ symbols: BinanceSymbol[] }>(
    'https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT',
  );
  return data.symbols.filter((s) => {
    if (s.status !== 'TRADING') return false;
    if (s.isSpotTradingAllowed) return true;
    const perms = new Set([...(s.permissions ?? []), ...(s.permissionSets ?? []).flat()]);
    return perms.has('SPOT');
  });
}

function pickBinanceSymbol(symbols: BinanceSymbol[]): string | null {
  for (const quote of ['USDT', 'USDC', 'FDUSD', 'BTC', 'ETH', 'BNB']) {
    const match = symbols.find((s) => s.quoteAsset === quote);
    if (match) return match.symbol;
  }
  return symbols[0]?.symbol ?? null;
}

async function fetchDepth(symbol: string): Promise<BinanceDepthResult | null> {
  const data = await fetchJson<BinanceDepthRaw>(
    `https://api.binance.com/api/v3/depth?symbol=${encodeURIComponent(symbol)}&limit=${BINANCE_DEPTH_LIMIT}`,
  );
  if (!data.bids.length || !data.asks.length) return null;

  const bestBid = Number(data.bids[0]![0]);
  const bestAsk = Number(data.asks[0]![0]);
  const mid = (bestBid + bestAsk) / 2;
  const lo = mid * (1 - DEPTH_WINDOW_PCT);
  const hi = mid * (1 + DEPTH_WINDOW_PCT);

  let bidDepth = 0;
  for (const [p, q] of data.bids) {
    if (Number(p) < lo) break;
    bidDepth += Number(p) * Number(q);
  }

  let askDepth = 0;
  for (const [p, q] of data.asks) {
    if (Number(p) > hi) break;
    askDepth += Number(p) * Number(q);
  }

  return {
    midPrice: mid,
    bidDepthUsdt: bidDepth,
    askDepthUsdt: askDepth,
    windowPct: DEPTH_WINDOW_PCT,
  };
}

const chainId = Number(requireEnv('CHAIN_ID'));
const chain = resolveChain(chainId);
const rpcUrl = requireEnv('MAINNET_RPC_URL');

const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 30_000 }) });

const factoryAddress: Address = '0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9';

console.log(`Chain: ${chain.name} (${chainId})`);
console.log('Fetching Binance spot symbols...');
const allBinanceSymbols = await fetchBinanceSpotSymbols();
const binanceByBase = new Map<string, BinanceSymbol[]>();
for (const s of allBinanceSymbols) {
  const base = s.baseAsset.toUpperCase();
  const arr = binanceByBase.get(base) ?? [];
  arr.push(s);
  binanceByBase.set(base, arr);
}
console.log(
  `Binance: ${allBinanceSymbols.length} spot symbols, ${binanceByBase.size} unique base assets\n`,
);

const results: PoolResult[] = [];

for (const token of KNOWN_TOKENS) {
  const tokenAddress = isAddress(token.address) ? getAddress(token.address) : null;
  if (!tokenAddress) {
    console.warn(`Skipping ${token.symbol}: invalid address`);
    continue;
  }

  const pairAddressRaw = await client.readContract({
    address: factoryAddress,
    abi: FACTORY_ABI,
    functionName: 'getPair',
    args: [tokenAddress, QUOTE_TOKEN],
  });

  if (pairAddressRaw === zeroAddress) {
    console.log(`${token.symbol.padEnd(8)} — no V2 pool`);
    continue;
  }

  const pairAddress = getAddress(pairAddressRaw);

  const [token0Raw, , reserves] = await Promise.all([
    client.readContract({ address: pairAddress, abi: PAIR_ABI, functionName: 'token0' }),
    client.readContract({ address: pairAddress, abi: PAIR_ABI, functionName: 'token1' }),
    client.readContract({ address: pairAddress, abi: PAIR_ABI, functionName: 'getReserves' }),
  ]);

  const [reserve0, reserve1, blockTimestampLast] = reserves;
  const isToken0 = token0Raw.toLowerCase() === tokenAddress.toLowerCase();
  const reserveToken = isToken0 ? reserve0 : reserve1;
  const reserveQuote = isToken0 ? reserve1 : reserve0;

  const quoteFormatted = formatUnits(reserveQuote, QUOTE_DECIMALS);
  const tokenFormatted = formatUnits(reserveToken, token.decimals);

  if (Number(quoteFormatted) < MIN_QUOTE_RESERVE) {
    console.log(
      `${token.symbol.padEnd(8)} — pool too thin (${Number(quoteFormatted).toFixed(2)} quote)`,
    );
    continue;
  }

  const tokenNum = Number(tokenFormatted);
  const impliedPrice = tokenNum > 0 ? (Number(quoteFormatted) / tokenNum).toFixed(8) : '0';

  const binanceSymbols = binanceByBase.get(token.symbol.toUpperCase()) ?? [];
  const binanceSymbol = pickBinanceSymbol(binanceSymbols);

  let depthResult: BinanceDepthResult | null = null;
  const warnings: string[] = [];

  if (binanceSymbol) {
    try {
      depthResult = await fetchDepth(binanceSymbol);
      const minDepth = depthResult
        ? Math.min(depthResult.bidDepthUsdt, depthResult.askDepthUsdt)
        : 0;
      if (minDepth < MIN_BINANCE_DEPTH_USDT) {
        console.log(`${token.symbol.padEnd(8)} — Binance depth too thin ($${minDepth.toFixed(0)})`);
        continue;
      }
    } catch (e) {
      warnings.push(`Binance depth fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    warnings.push('No Binance spot market found');
  }

  results.push({
    symbol: token.symbol,
    tokenAddress,
    tokenDecimals: token.decimals,
    pairAddress,
    reserveQuote: reserveQuote.toString(),
    reserveToken: reserveToken.toString(),
    quoteReserveFormatted: quoteFormatted,
    tokenReserveFormatted: tokenFormatted,
    impliedPrice,
    blockTimestampLast: Number(blockTimestampLast),
    binanceSymbol,
    binanceDepth: depthResult,
    warnings,
  });

  console.log(
    `${token.symbol.padEnd(8)} ✓  pair=${pairAddress}  quoteReserve=${Number(quoteFormatted).toFixed(4)}` +
      `  binance=${binanceSymbol ?? 'n/a'}` +
      (depthResult
        ? `  depth=$${Math.min(depthResult.bidDepthUsdt, depthResult.askDepthUsdt).toFixed(0)}`
        : ''),
  );
}

results.sort((a, b) => Number(b.quoteReserveFormatted) - Number(a.quoteReserveFormatted));

await fs.writeFile(OUTPUT_FILE, JSON.stringify(results, null, 2));

console.log(`\nFound ${results.length} viable pools. Saved to ${OUTPUT_FILE}\n`);
console.table(
  results.map((r) => ({
    symbol: r.symbol,
    pair: r.pairAddress,
    quoteReserve: Number(r.quoteReserveFormatted).toFixed(4),
    priceQuote: r.impliedPrice,
    binance: r.binanceSymbol,
    bidDepth: r.binanceDepth ? `$${r.binanceDepth.bidDepthUsdt.toFixed(0)}` : 'n/a',
    askDepth: r.binanceDepth ? `$${r.binanceDepth.askDepthUsdt.toFixed(0)}` : 'n/a',
  })),
);
