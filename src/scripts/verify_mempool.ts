#!/usr/bin/env tsx
/**
 * Usage: npx tsx src/scripts/verify_mempool.ts
 */
import { config } from '@/configs/configs.service';
import { MempoolMonitor } from '@/pricing/mempool/mempool.service';

const wsUrl = config.chain.mainnetRpcUrl.replace('https', 'wss');

const monitor = new MempoolMonitor(wsUrl, (swap) => {
  console.log(`[${new Date().toISOString()}] ${swap.method}`);
  console.log(`  router:   ${swap.router.value}`);
  console.log(`  tokenIn:  ${swap.tokenIn?.value ?? 'ETH'}`);
  console.log(`  tokenOut: ${swap.tokenOut?.value ?? 'ETH'}`);
  console.log(`  amountIn: ${swap.amountIn.toString()}`);
  console.log(`  minOut:   ${swap.minAmountOut.toString()}`);
  console.log('');
});

await monitor.start();
console.log('Listening for Uniswap V2 swaps... (Ctrl+C to stop)');
