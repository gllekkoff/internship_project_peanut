#!/usr/bin/env tsx
import 'dotenv/config';
import { createWalletClient, createPublicClient, http, erc20Abi, maxUint256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum } from 'viem/chains';

const forkRpc = process.env['FORK_RPC_URL'] ?? 'http://127.0.0.1:8545';
const privateKey = process.env['PRIVATE_KEY'] as `0x${string}`;
const router = process.env['ROUTER'] as `0x${string}`;
const baseToken = process.env['BASE_TOKEN'] as `0x${string}`;
const quoteToken = process.env['QUOTE_TOKEN'] as `0x${string}`;

for (const [name, val] of [
  ['PRIVATE_KEY', privateKey],
  ['ROUTER', router],
  ['BASE_TOKEN', baseToken],
  ['QUOTE_TOKEN', quoteToken],
] as const) {
  if (!val) throw new Error(`Missing env var: ${name}`);
}

const account = privateKeyToAccount(privateKey);
const transport = http(forkRpc);

const wallet = createWalletClient({ account, chain: arbitrum, transport });
const publicClient = createPublicClient({ chain: arbitrum, transport });

async function approve(token: `0x${string}`, symbol: string): Promise<void> {
  const allowance = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account.address, router],
  });

  if (allowance === maxUint256) {
    console.log(`${symbol} (${token}): already approved`);
    return;
  }

  const hash = await wallet.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [router, maxUint256],
  });
  console.log(`${symbol} (${token}): approved — tx ${hash}`);
}

console.log(`Fork: ${forkRpc}`);
console.log(`Wallet: ${account.address}`);
console.log(`Router: ${router}\n`);

await approve(baseToken, 'BASE_TOKEN');
await approve(quoteToken, 'QUOTE_TOKEN');
