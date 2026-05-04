#!/usr/bin/env tsx
/**
 * Fetches live reserves and implied price for the configured pool.
 * Quick sanity check — use this to confirm POOL address and RPC are correct before running the bot.
 *
 * Usage:
 *   npx tsx src/scripts/verify_pool.script.ts
 *
 * Required env: CHAIN_ID, MAINNET_RPC_URL, POOL, BASE_TOKEN, QUOTE_TOKEN
 */
import { config, chain as viemChain } from '@/configs/configs.service';
import { ChainClient } from '@/chain/chain.client';
import { UniswapV2Pair } from '@/pricing/uniswap-v2/uniswap-v2.service';
import { Address } from '@/core/core.types';

const client = new ChainClient([config.chain.rpcUrl], 30, 3, viemChain);
const poolAddress = new Address(config.dex.pool);

console.log(`Chain:      ${viemChain.name} (id=${config.chain.id})`);
console.log(`Pool:       ${poolAddress.value}`);
console.log(`Base token: ${config.dex.baseToken}`);
console.log(`Quote token:${config.dex.quoteToken}`);
console.log('');

const pair = await UniswapV2Pair.fromChain(poolAddress, client);

const baseLower = config.dex.baseToken.toLowerCase();
const baseIsToken0 = pair.token0.address.lower === baseLower;
if (!baseIsToken0 && pair.token1.address.lower !== baseLower) {
  console.error(`BASE_TOKEN ${config.dex.baseToken} not found in pool`);
  process.exit(1);
}

const baseToken = baseIsToken0 ? pair.token0 : pair.token1;
const quoteToken = baseIsToken0 ? pair.token1 : pair.token0;
const baseReserve = baseIsToken0 ? pair.reserve0 : pair.reserve1;
const quoteReserve = baseIsToken0 ? pair.reserve1 : pair.reserve0;

const baseHuman = Number(baseReserve) / 10 ** baseToken.decimals;
const quoteHuman = Number(quoteReserve) / 10 ** quoteToken.decimals;
const impliedPrice = quoteHuman / baseHuman;

console.log(`${baseToken.symbol}: ${baseHuman.toFixed(4)}`);
console.log(`${quoteToken.symbol}: ${quoteHuman.toFixed(2)}`);
console.log(`Implied price: $${impliedPrice.toFixed(2)} per ${baseToken.symbol}`);
console.log('');

if (baseReserve > 0n && quoteReserve > 0n) {
  console.log('✓ Non-zero reserves — pool and RPC are working');
} else {
  console.log('✗ Zero reserves — check POOL address or RPC');
  process.exit(1);
}
