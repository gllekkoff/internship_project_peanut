#!/usr/bin/env tsx
import 'dotenv/config';
import { resolveToken } from '@/integration/arbBot/arb_bot.utils';
import {
  createPublicClient,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseAbi,
} from 'viem';
import type { Address as ViemAddress } from 'viem';
import { arbitrum, mainnet, sepolia } from 'viem/chains';
import type { Chain } from 'viem';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const FACTORY_ABI = parseAbi([
  'function getPair(address tokenA, address tokenB) view returns (address pair)',
]);
const PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);

const DEFAULT_FACTORIES: readonly FactoryCandidate[] = [
  {
    name: 'Uniswap V2',
    address: '0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9',
  },
  {
    name: 'SushiSwap V2',
    address: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
  },
  {
    name: 'PancakeSwapV2',
    address: '0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E',
  },
];

interface FactoryCandidate {
  readonly name: string;
  readonly address: ViemAddress;
}

interface TokenInfo {
  readonly address: ViemAddress;
  readonly symbol: string;
  readonly decimals: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalEnv(name: string): string | null {
  return process.env[name] ?? null;
}

function optionalAddress(name: string): ViemAddress | null {
  const value = optionalEnv(name);
  if (!value) return null;
  if (!isAddress(value)) throw new Error(`${name} is not a valid EVM address: ${value}`);
  return getAddress(value);
}

function resolveChain(chainId: number): Chain {
  if (chainId === arbitrum.id) return arbitrum;
  if (chainId === mainnet.id) return mainnet;
  if (chainId === sepolia.id) return sepolia;
  throw new Error(
    `Unsupported CHAIN_ID ${chainId}. Add it to find_pool.script.ts before using this script.`,
  );
}

function resolveRpcUrl(): string {
  return requireEnv('MAINNET_RPC_URL');
}

function redactRpcUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = parsed.username ? '***' : '';
    parsed.password = parsed.password ? '***' : '';
    const segments = parsed.pathname.split('/');
    if (segments.length > 2) segments[segments.length - 1] = '***';
    parsed.pathname = segments.join('/');
    return parsed.toString();
  } catch {
    return '<configured RPC URL>';
  }
}

function getFactories(): readonly FactoryCandidate[] {
  const envFactory = optionalAddress('FACTORY');
  if (!envFactory) return DEFAULT_FACTORIES;

  return [
    { name: 'FACTORY env', address: envFactory },
    ...DEFAULT_FACTORIES.filter(
      (candidate) => candidate.address.toLowerCase() !== envFactory.toLowerCase(),
    ),
  ];
}

async function getTokenInfo(address: ViemAddress): Promise<TokenInfo> {
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address, abi: erc20Abi, functionName: 'symbol' }),
    client.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
  ]);

  return { address, symbol, decimals };
}

function parseTokenArgs(argv: string[]): { base: ViemAddress; quote: ViemAddress } {
  let base: string | undefined;
  let quote: string | undefined;
  const positional: string[] = [];

  for (let i = 2; i < argv.length; i++) {
    if ((argv[i] === '-B' || argv[i] === '--base-token') && argv[i + 1]) {
      base = resolveToken(argv[++i]!);
    } else if ((argv[i] === '-Q' || argv[i] === '--quote-token') && argv[i + 1]) {
      quote = resolveToken(argv[++i]!);
    } else if (argv[i] && !argv[i]!.startsWith('-')) {
      positional.push(argv[i]!);
    }
  }

  if (positional[0] && !base) base = resolveToken(positional[0]);
  if (positional[1] && !quote) quote = resolveToken(positional[1]);

  base ??= requireEnv('BASE_TOKEN');
  quote ??= requireEnv('QUOTE_TOKEN');

  if (!isAddress(base)) throw new Error(`Invalid base token address: ${base}`);
  if (!isAddress(quote)) throw new Error(`Invalid quote token address: ${quote}`);
  return { base: getAddress(base), quote: getAddress(quote) };
}

const chainId = Number(requireEnv('CHAIN_ID'));
const chain = resolveChain(chainId);
const rpcUrl = resolveRpcUrl();
const { base: baseToken, quote: quoteToken } = parseTokenArgs(process.argv);
const factories = getFactories();

const client = createPublicClient({
  chain,
  transport: http(rpcUrl, { timeout: 30_000 }),
});

console.log(`Chain:       ${chain.name} (${chain.id})`);
console.log(`RPC:         ${redactRpcUrl(rpcUrl)}`);
console.log(`BASE_TOKEN:  ${baseToken}`);
console.log(`QUOTE_TOKEN: ${quoteToken}`);
console.log('');

let foundNonZeroPool = false;

for (const factory of factories) {
  console.log(`Checking ${factory.name} factory: ${factory.address}`);

  const pairAddress = await client.readContract({
    address: factory.address,
    abi: FACTORY_ABI,
    functionName: 'getPair',
    args: [baseToken, quoteToken],
  });

  if (pairAddress === ZERO_ADDRESS) {
    console.log('  Pool: not found');
    console.log('');
    continue;
  }

  const [token0Address, token1Address, [reserve0, reserve1]] = await Promise.all([
    client.readContract({ address: pairAddress, abi: PAIR_ABI, functionName: 'token0' }),
    client.readContract({ address: pairAddress, abi: PAIR_ABI, functionName: 'token1' }),
    client.readContract({ address: pairAddress, abi: PAIR_ABI, functionName: 'getReserves' }),
  ]);

  const [token0, token1] = await Promise.all([
    getTokenInfo(token0Address),
    getTokenInfo(token1Address),
  ]);

  const baseIsToken0 = token0.address.toLowerCase() === baseToken.toLowerCase();
  const baseInfo = baseIsToken0 ? token0 : token1;
  const quoteInfo = baseIsToken0 ? token1 : token0;
  const baseReserve = baseIsToken0 ? reserve0 : reserve1;
  const quoteReserve = baseIsToken0 ? reserve1 : reserve0;

  const baseHuman = Number(formatUnits(baseReserve, baseInfo.decimals));
  const quoteHuman = Number(formatUnits(quoteReserve, quoteInfo.decimals));
  const impliedPrice = baseHuman > 0 ? quoteHuman / baseHuman : 0;

  console.log(`  Pool:   ${pairAddress}`);
  console.log(`  token0: ${token0.symbol} (${token0.address})`);
  console.log(`  token1: ${token1.symbol} (${token1.address})`);
  console.log(`  ${baseInfo.symbol} reserve:  ${baseHuman.toFixed(4)}`);
  console.log(`  ${quoteInfo.symbol} reserve: ${quoteHuman.toFixed(2)}`);
  console.log(
    `  Implied price: ${impliedPrice.toFixed(2)} ${quoteInfo.symbol} per ${baseInfo.symbol}`,
  );

  if (baseReserve > 0n && quoteReserve > 0n) {
    foundNonZeroPool = true;
    console.log('  Result: ✓ non-zero reserves');
  } else {
    console.log('  Result: ✗ pool exists but one side has zero reserves');
  }
  console.log('');
}

if (!foundNonZeroPool) {
  console.error(
    `No ${baseToken}/${quoteToken} pool with non-zero reserves was found in the configured factories.`,
  );
  process.exit(1);
}
