#!/usr/bin/env tsx
/**
 * Requires a running Anvil fork — start one with src/scripts/start_fork.sh
 * Usage: npx tsx src/scripts/verify_amm.ts
 */
import { config } from '@/core/core.config';
import { Address } from '@/core/core.types';
import { ChainClient } from '@/chain/chain.client';
import { UniswapV2Pair } from '@/pricing/uniswap-v2/uniswap-v2.service';
import { ForkSimulator } from '@/pricing/forkSimulator/fork.service';

const FORK_URL = process.env['FORK_URL'] ?? 'http://127.0.0.1:8545';
const ROUTER = new Address('0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D');
const PAIR_ADDR = new Address('0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc'); // USDC/WETH

void config;

const client = new ChainClient([FORK_URL]);
const sim = new ForkSimulator(FORK_URL);

const pair = await UniswapV2Pair.fromChain(PAIR_ADDR, client);
const tokenIn = pair.token0; // USDC

const result = await sim.compareSimulationVsCalculation(
  ROUTER,
  pair,
  2_000n * 10n ** 6n, // 2000 USDC
  tokenIn,
);

console.log('Calculated:', result.calculated.toString());
console.log('Simulated: ', result.simulated.toString());
console.log('Difference:', result.difference.toString());
console.log('Match:     ', result.match);

if (!result.match) process.exit(1);
