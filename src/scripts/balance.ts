#!/usr/bin/env tsx
import { formatEther } from 'viem';
import { sepolia } from 'viem/chains';
import { config } from '@/core/core.config';
import { WalletManager } from '@/core/wallet.service';
import { ChainClient } from '@/chain/chain.client';
import { Address } from '@/core/core.types';

if (!config.sepoliaRpcUrl) {
  console.error('SEPOLIA_RPC_URL is not set');
  process.exit(1);
}

const wallet = WalletManager.from_env('PRIVATE_KEY');
const client = new ChainClient([config.sepoliaRpcUrl], 30, 3, sepolia);
const balance = await client.getBalance(new Address(wallet.getAddress()));

console.log(`Address: ${wallet.getAddress()}`);
console.log(`Balance: ${formatEther(balance.raw)} ETH`);
