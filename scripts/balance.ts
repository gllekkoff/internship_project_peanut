#!/usr/bin/env tsx
import 'dotenv/config';
import { formatEther } from 'viem';
import { mainnet, sepolia } from 'viem/chains';
import { WalletManager } from '../core/walletManager.js';
import { ChainClient } from '../chain/chainClient.js';
import { Address } from '../core/baseTypes.js';

const wallet = WalletManager.from_env('PRIVATE_KEY');
const client = new ChainClient([process.env['SEPOLIA_RPC_URL']!], 30, 3, sepolia);
const balance = await client.getBalance(new Address(wallet.getAddress()));

console.log(`Address: ${wallet.getAddress()}`);
console.log(`Balance: ${formatEther(balance.raw)} ETH`);
