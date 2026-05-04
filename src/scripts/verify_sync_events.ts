#!/usr/bin/env tsx
/**
 * Listens to Sync events on the configured pool and prints every reserve
 * change with timestamp, amounts, and implied price.
 * Run for ~5 minutes, then compare the output line-by-line with dexscreener.
 *
 * Usage: npx tsx src/scripts/verify_sync_events.ts
 */
import { createPublicClient, parseAbi, webSocket, formatUnits } from 'viem';
import { config, chain as viemChain } from '@/configs/configs.service';
import { UniswapV2Pair } from '@/pricing/uniswap-v2/uniswap-v2.service';
import { ChainClient } from '@/chain/chain.client';
import { Address } from '@/core/core.types';

const SYNC_ABI = parseAbi(['event Sync(uint112 reserve0, uint112 reserve1)']);

const poolAddress = new Address(config.dex.pool);
const client = new ChainClient([config.chain.rpcUrl], 30, 3, viemChain);

console.log(`Chain:   ${viemChain.name} (id=${config.chain.id})`);
console.log(`Pool:    ${poolAddress.value}`);
console.log(`WS URL:  ${config.chain.wsUrl}`);
console.log('');
console.log('Loading pair metadata...');

const pair = await UniswapV2Pair.fromChain(poolAddress, client);
const { token0, token1 } = pair;

console.log(`token0:  ${token0.symbol} (${token0.decimals} decimals)`);
console.log(`token1:  ${token1.symbol} (${token1.decimals} decimals)`);
console.log('');
console.log('Listening for Sync events... (Ctrl+C to stop)');
console.log('Compare timestamps and amounts with https://dexscreener.com');
console.log('─'.repeat(80));

let prevR0: bigint | null = null;
let prevR1: bigint | null = null;
let eventCount = 0;

const wsClient = createPublicClient({
  chain: viemChain,
  transport: webSocket(config.chain.wsUrl),
});

wsClient.watchContractEvent({
  address: poolAddress.value as `0x${string}`,
  abi: SYNC_ABI,
  eventName: 'Sync',
  onLogs: (logs) => {
    for (const log of logs) {
      const r0 = log.args.reserve0;
      const r1 = log.args.reserve1;
      if (r0 === undefined || r1 === undefined) continue;

      eventCount++;
      const ts = new Date().toISOString().replace('T', ' ').slice(0, 23);

      const r0Human = Number(formatUnits(r0, token0.decimals));
      const r1Human = Number(formatUnits(r1, token1.decimals));
      const price = r1Human / r0Human;

      // Delta vs previous sync — this is the swap amount
      const delta0 = prevR0 !== null ? r0 - prevR0 : null;
      const delta1 = prevR1 !== null ? r1 - prevR1 : null;

      const d0Str =
        delta0 !== null
          ? `${delta0 >= 0n ? '+' : ''}${Number(formatUnits(delta0, token0.decimals)).toFixed(6)} ${token0.symbol}`
          : 'first event';
      const d1Str =
        delta1 !== null
          ? `${delta1 >= 0n ? '+' : ''}${Number(formatUnits(delta1, token1.decimals)).toFixed(2)} ${token1.symbol}`
          : '';

      console.log(`[${ts}] #${eventCount}  tx: ${log.transactionHash ?? 'pending'}`);
      console.log(`  reserve0: ${r0Human.toFixed(6)} ${token0.symbol}`);
      console.log(`  reserve1: ${r1Human.toFixed(2)} ${token1.symbol}`);
      console.log(`  price:    $${price.toFixed(2)} per ${token0.symbol}`);
      console.log(`  delta:    ${d0Str}  ${d1Str}`);
      console.log('');

      prevR0 = r0;
      prevR1 = r1;
    }
  },
});
