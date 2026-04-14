#!/usr/bin/env tsx
import {
  formatEther,
  formatUnits,
  recoverTransactionAddress,
  type Hex,
  type TransactionSerializable,
} from 'viem';
import { sepolia } from 'viem/chains';
import { config } from '@/core/core.config';
import { WalletManager } from '@/core/wallet.service';
import { ChainClient } from '@/chain/chain.client';
import { TransactionBuilder, SignedTransaction } from '@/chain/transaction.service';
import { Address, TokenAmount } from '@/core/core.types';

const TEST_RECIPIENT = '0x000000000000000000000000000000000000dEaD';

async function main() {
  if (!config.sepoliaRpcUrl) {
    console.error('Error: SEPOLIA_RPC_URL environment variable not set');
    process.exit(1);
  }

  const wallet = WalletManager.from_env('PRIVATE_KEY');
  const address = wallet.getAddress();
  const client = new ChainClient([config.sepoliaRpcUrl], 30, 3, sepolia);

  const walletAddress = new Address(address);
  const balance = await client.getBalance(walletAddress);

  console.log(`Wallet: ${address}`);
  console.log(`Balance: ${formatEther(balance.raw)} ETH`);
  console.log();

  const minBalance = TokenAmount.fromHuman('0.002', 18);
  if (balance.raw < minBalance.raw) {
    console.error('Insufficient balance — need at least 0.002 ETH on Sepolia');
    process.exit(1);
  }

  const recipient = new Address(TEST_RECIPIENT ?? address);
  const value = TokenAmount.fromHuman('0.001', 18, 'ETH');

  console.log('Building transaction...');
  console.log(`  To:    ${recipient.value}`);
  console.log(`  Value: 0.001 ETH`);

  const builder = new TransactionBuilder(client, wallet)
    .to(recipient)
    .value(value)
    .withGasEstimate()
    .withGasPrice('medium');

  const tx = await builder.build();

  console.log(`  Estimated Gas:  ${tx.gasLimit?.toLocaleString() ?? 'n/a'}`);
  console.log(
    `  Max Fee:        ${tx.maxFeePerGas ? formatUnits(tx.maxFeePerGas, 9) + ' gwei' : 'n/a'}`,
  );
  console.log(
    `  Max Priority:   ${tx.maxPriorityFee ? formatUnits(tx.maxPriorityFee, 9) + ' gwei' : 'n/a'}`,
  );
  console.log();

  console.log('Signing...');
  const serializable: TransactionSerializable = {
    to: tx.to.value as Hex,
    value: tx.value.raw,
    nonce: tx.nonce ?? 0,
    gas: tx.gasLimit ?? undefined,
    maxFeePerGas: tx.maxFeePerGas ?? undefined,
    maxPriorityFeePerGas: tx.maxPriorityFee ?? undefined,
    chainId: tx.chainId,
    ...(tx.data.length > 0 && { data: `0x${Buffer.from(tx.data).toString('hex')}` as Hex }),
  };

  const serialized = await wallet.signTransaction(serializable);
  const signed = new SignedTransaction(serialized);

  const recovered = await recoverTransactionAddress({
    serializedTransaction: signed.serialized as `0x02${string}`, // EIP-1559 tx
  });
  const sigValid = recovered.toLowerCase() === address.toLowerCase();

  console.log(`  Signature valid:           ${sigValid ? '✓' : '✗'}`);
  console.log(`  Recovered address matches: ${sigValid ? '✓' : '✗'}`);
  console.log();

  if (!sigValid) {
    console.error('Signature verification failed — aborting');
    process.exit(1);
  }

  console.log('Sending...');
  const txHash = await client.sendTransaction(signed.toBytes());
  console.log(`  TX Hash: ${txHash}`);
  console.log();

  console.log('Waiting for confirmation...');
  const receipt = await client.waitForReceipt(txHash, 120);

  const gasUsedPct = tx.gasLimit
    ? ((Number(receipt.gasUsed) / Number(tx.gasLimit)) * 100).toFixed(0)
    : '?';

  console.log(`  Block:    ${receipt.blockNumber.toLocaleString()}`);
  console.log(`  Status:   ${receipt.status ? 'SUCCESS' : 'FAILED'}`);
  console.log(`  Gas Used: ${receipt.gasUsed.toLocaleString()} (${gasUsedPct}%)`);
  console.log(`  Fee:      ${formatEther(receipt.txFee.raw)} ETH`);
  console.log();

  if (!receipt.status) {
    console.error('Integration test FAILED — transaction reverted');
    process.exit(1);
  }

  console.log('Integration test PASSED');
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
