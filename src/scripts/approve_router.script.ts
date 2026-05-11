#!/usr/bin/env tsx
/**
 * One-time script: approves the configured Uniswap router to spend both base and quote tokens.
 * Run once before your first real trade.
 * Usage: npm run approve
 */
import { erc20Abi, maxUint256, encodeFunctionData } from 'viem';
import type { Hex } from 'viem';
import { config, chain as viemChain } from '@/configs/configs.service';
import { Address } from '@/core/core.types';
import { WalletManager } from '@/core/wallet.service';
import { ChainClient } from '@/chain/chain.client';
import { TransactionBuilder } from '@/chain/transaction.service';

const wallet = WalletManager.from_env('PRIVATE_KEY');
const chainClient = new ChainClient([config.chain.rpcUrl], 30, 3, viemChain);
const routerAddress = config.dex.router as Hex;
const walletAddress = wallet.getAddress() as Hex;

console.log(`Wallet : ${walletAddress}`);
console.log(`Router : ${routerAddress}\n`);

async function approveToken(tokenAddress: Hex, label: string): Promise<void> {
  const existing = (await chainClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [walletAddress, routerAddress],
  })) as bigint;

  console.log(`${label} (${tokenAddress})`);
  console.log(`  Current allowance: ${existing.toString()}`);

  if (existing >= maxUint256 / 2n) {
    console.log(`  Already approved — skipping.\n`);
    return;
  }

  const calldata = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [routerAddress, maxUint256],
  });

  const receipt = await new TransactionBuilder(chainClient, wallet)
    .to(new Address(tokenAddress))
    .data(Buffer.from(calldata.slice(2), 'hex'))
    .gasLimit(60_000n)
    .withGasPrice('medium')
    .sendAndWait(60);

  console.log(`  Approved! tx: ${receipt.txHash}\n`);
}

await approveToken(config.dex.baseToken as Hex, 'Base token');
await approveToken(config.dex.quoteToken as Hex, 'Quote token');

console.log('Both tokens approved. You can now run the bot.');
