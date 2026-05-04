#!/usr/bin/env tsx
/**
 * Sepolia connectivity test for the TransactionBuilder + ChainClient pipeline.
 *
 * Usage:
 *   npx tsx src/scripts/test_dex_leg.script.ts          # estimate gas only (safe, no tx sent)
 *   npx tsx src/scripts/test_dex_leg.script.ts --send   # send a 0-value self-transfer on Sepolia
 *
 * Required env: SEPOLIA_RPC_URL, PRIVATE_KEY
 */
import { formatEther } from 'viem';
import { sepolia } from 'viem/chains';
import { config } from '@/configs/configs.service';
import { WalletManager } from '@/core/wallet.service';
import { ChainClient } from '@/chain/chain.client';
import { TransactionBuilder } from '@/chain/transaction.service';
import { Address, TokenAmount } from '@/core/core.types';

if (!config.chain.sepoliaRpcUrl) {
  console.error('SEPOLIA_RPC_URL is not set — add it to your .env');
  process.exit(1);
}

const SEND = process.argv.includes('--send');

const wallet = WalletManager.from_env('PRIVATE_KEY');
const client = new ChainClient([config.chain.sepoliaRpcUrl], 30, 3, sepolia);
const address = new Address(wallet.getAddress());

console.log('\n=== Sepolia DEX Leg Pipeline Test ===');
console.log(`Address:  ${address.value}`);

const balance = await client.getBalance(address);
console.log(`Balance:  ${formatEther(balance.raw)} SEP`);

if (balance.raw === 0n) {
  console.warn('Warning: zero balance — gas estimation may fail');
}

// A 0-value self-transfer is the simplest valid tx — proves signing + broadcast work without spending funds.
const makeBuilder = () =>
  new TransactionBuilder(client, wallet)
    .to(address)
    .value(new TokenAmount(0n, 18, 'ETH'))
    .withGasEstimate(1.2)
    .withGasPrice('medium');

console.log('\n[1] Estimating gas for 0-value self-transfer...');
const tx = await makeBuilder().build();
const gasPrice = await client.getGasPrice();
const gasLimit = tx.gasLimit ?? 21_000n;
const feeCost = gasLimit * gasPrice.getMaxFee('medium');

console.log(`  Gas limit:     ${gasLimit.toLocaleString()} units`);
console.log(`  Max fee/gas:   ${formatEther(gasPrice.getMaxFee('medium'))} ETH`);
console.log(`  Est. fee cost: ${formatEther(feeCost)} ETH`);

if (!SEND) {
  console.log('\n[2] Skipping broadcast (pass --send to send the transaction)');
  console.log('\n=== Done ===\n');
  process.exit(0);
}

console.log('\n[2] Sending 0-value self-transfer on Sepolia...');
const receipt = await makeBuilder().sendAndWait(60);

console.log(`  Tx hash:   ${receipt.txHash}`);
console.log(`  Block:     ${receipt.blockNumber}`);
console.log(`  Gas used:  ${receipt.gasUsed.toLocaleString()} units`);
console.log(`  Fee paid:  ${formatEther(receipt.txFee.raw)} ETH`);
console.log(`  Status:    ${receipt.status ? 'SUCCESS' : 'FAILED'}`);

console.log('\n=== Done ===\n');
