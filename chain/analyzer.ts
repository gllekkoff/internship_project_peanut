#!/usr/bin/env tsx
/**
 * Transaction Analyzer CLI
 * Usage: npx tsx chain/analyzer.ts <tx_hash> [--rpc <url>] [--trace] [--format json]
 */

import {
  createPublicClient,
  decodeFunctionData,
  decodeEventLog,
  formatEther,
  formatUnits,
  http,
  type Hex,
  type PublicClient,
} from 'viem';
import { mainnet } from 'viem/chains';

import {
  DEFAULT_RPC,
  FUNCTION_ABIS,
  TRANSFER_ABI,
  ERC20_ABI,
  TRANSFER_TOPIC,
  row,
  gwei,
  ts,
  sep,
  pct,
} from './analyzer.constants.js';

import type { CallFrame, TransferInfo } from './analyzer.interface.js';

const tokenCache = new Map<string, { symbol: string; decimals: number }>();

async function getToken(client: PublicClient, address: string) {
  const hit = tokenCache.get(address);
  if (hit !== undefined) return hit;
  try {
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address: address as Hex, abi: ERC20_ABI, functionName: 'symbol' }),
      client.readContract({ address: address as Hex, abi: ERC20_ABI, functionName: 'decimals' }),
    ]);
    const info = { symbol, decimals };
    tokenCache.set(address, info);
    return info;
  } catch {
    const info = { symbol: `${address.slice(0, 6)}…`, decimals: 18 };
    tokenCache.set(address, info);
    return info;
  }
}

async function fetchTrace(rpcUrl: string, txHash: string): Promise<CallFrame | null> {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'debug_traceTransaction',
        params: [txHash, { tracer: 'callTracer' }],
      }),
    });
    const json = (await res.json()) as { result?: CallFrame; error?: { message: string } };
    return json.result ?? null;
  } catch {
    return null;
  }
}

function renderCallTree(call: CallFrame, depth = 0): void {
  const indent = '  '.repeat(depth);
  const value =
    call.value && call.value !== '0x0' && call.value !== '0x'
      ? ` [${formatEther(BigInt(call.value))} ETH]`
      : '';
  const status = call.error ? ` !! ${call.error}` : '';
  console.log(`${indent}${call.type} → ${call.to ?? '(deploy)'}${value}${status}`);
  for (const sub of call.calls ?? []) {
    renderCallTree(sub, depth + 1);
  }
}

async function analyze(
  txHash: string,
  rpcUrl: string,
  showTrace: boolean,
  outputFormat: 'text' | 'json',
): Promise<void> {
  const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) });

  let tx;
  try {
    tx = await client.getTransaction({ hash: txHash as Hex });
  } catch {
    console.error(`Transaction not found: ${txHash}`);
    process.exit(1);
  }

  const [receipt, traceResult] = await Promise.all([
    client.getTransactionReceipt({ hash: txHash as Hex }).catch(() => null),
    showTrace ? fetchTrace(rpcUrl, txHash) : Promise.resolve(null),
  ]);
  const block = receipt ? await client.getBlock({ blockNumber: receipt.blockNumber }) : null;

  let funcName: string | undefined;
  let funcArgs: unknown[] | undefined;
  if (tx.input !== '0x') {
    try {
      const decoded = decodeFunctionData({ abi: FUNCTION_ABIS, data: tx.input });
      funcName = decoded.functionName;
      funcArgs = decoded.args ? [...decoded.args] : [];
    } catch {
      funcName = undefined;
    }
  }

  const transfers: TransferInfo[] = [];
  if (receipt) {
    for (const log of receipt.logs.filter((l) => l.topics[0] === TRANSFER_TOPIC)) {
      try {
        const { args } = decodeEventLog({ abi: TRANSFER_ABI, ...log });
        const tokenInfo = await getToken(client, log.address);
        transfers.push({
          token: log.address,
          symbol: tokenInfo.symbol,
          from: args.from as string,
          to: args.to as string,
          amount: formatUnits(args.value, tokenInfo.decimals),
          rawValue: args.value,
          decimals: tokenInfo.decimals,
        });
      } catch {}
    }
  }

  if (outputFormat === 'json') {
    const result: Record<string, unknown> = {
      hash: txHash,
      status: receipt ? (receipt.status === 'success' ? 'SUCCESS' : 'FAILED') : 'PENDING',
      block: receipt ? Number(receipt.blockNumber) : null,
      timestamp: block ? ts(block.timestamp) : null,
      from: tx.from,
      to: tx.to ?? null,
      value: formatEther(tx.value),
    };

    if (receipt) {
      const baseFee =
        tx.maxPriorityFeePerGas !== undefined
          ? receipt.effectiveGasPrice - tx.maxPriorityFeePerGas
          : null;
      result['gas'] = {
        limit: Number(tx.gas),
        used: Number(receipt.gasUsed),
        usedPct: pct(receipt.gasUsed, tx.gas),
        baseFee: baseFee !== null ? gwei(baseFee > 0n ? baseFee : 0n) : undefined,
        priorityFee:
          tx.maxPriorityFeePerGas !== undefined ? gwei(tx.maxPriorityFeePerGas) : undefined,
        effectivePrice: gwei(receipt.effectiveGasPrice),
        feePaid: formatEther(receipt.gasUsed * receipt.effectiveGasPrice),
      };
    }

    if (tx.input !== '0x') {
      result['function'] = {
        selector: tx.input.slice(0, 10),
        name: funcName ?? '(unknown)',
        args: funcArgs,
      };
    }

    if (transfers.length > 0) result['transfers'] = transfers;

    if (funcName?.toLowerCase().includes('swap')) {
      const isEthIn = funcName === 'swapExactETHForTokens';
      const soldTransfer = isEthIn
        ? null
        : transfers.find((t) => t.from.toLowerCase() === tx.from.toLowerCase());
      const received = transfers.find((t) => t.to.toLowerCase() === tx.from.toLowerCase());
      const soldNum = isEthIn
        ? Number(tx.value) / 1e18
        : soldTransfer
          ? Number(soldTransfer.rawValue) / 10 ** soldTransfer.decimals
          : null;
      const receivedNum = received ? Number(received.rawValue) / 10 ** received.decimals : null;
      if (soldNum && received && receivedNum) {
        result['swap'] = {
          sold: isEthIn
            ? `${formatEther(tx.value)} ETH`
            : `${soldTransfer!.amount} ${soldTransfer!.symbol}`,
          received: `${received.amount} ${received.symbol}`,
          executionPrice: `${(soldNum / receivedNum).toFixed(4)} ${isEthIn ? 'ETH' : soldTransfer!.symbol}/${received.symbol}`,
        };
      }
    }

    if (traceResult) result['trace'] = traceResult;

    console.log(JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    return;
  }

  console.log('\nTransaction Analysis\n====================');
  row('Hash:', txHash);
  if (receipt && block) {
    row('Block:', Number(receipt.blockNumber).toLocaleString());
    row('Timestamp:', ts(block.timestamp));
    row('Status:', receipt.status === 'success' ? 'SUCCESS' : 'FAILED');
  } else {
    row('Status:', 'PENDING (not yet mined)');
  }
  console.log('');
  row('From:', tx.from);
  row('To:', tx.to ?? '(contract creation)');
  row('Value:', `${formatEther(tx.value)} ETH`);

  if (receipt) {
    sep('Gas Analysis');
    row('Gas Limit:', Number(tx.gas).toLocaleString());
    row(
      'Gas Used:',
      `${Number(receipt.gasUsed).toLocaleString()} (${pct(receipt.gasUsed, tx.gas)})`,
    );
    if (tx.maxFeePerGas !== undefined && tx.maxPriorityFeePerGas !== undefined) {
      const baseFee = receipt.effectiveGasPrice - tx.maxPriorityFeePerGas;
      row('Base Fee:', gwei(baseFee > 0n ? baseFee : 0n));
      row('Priority Fee:', gwei(tx.maxPriorityFeePerGas));
    }
    row('Effective Price:', gwei(receipt.effectiveGasPrice));
    row('Fee paid:', `${formatEther(receipt.gasUsed * receipt.effectiveGasPrice)} ETH`);
  }

  if (tx.input !== '0x') {
    sep('Function Called');
    row('Selector:', tx.input.slice(0, 10));
    if (funcName) {
      row('Function:', funcName);
      if (funcArgs && funcArgs.length > 0) {
        console.log('Arguments:');
        for (const [i, arg] of funcArgs.entries()) {
          const display = Array.isArray(arg)
            ? `[${(arg as unknown[]).map(String).join(', ')}]`
            : String(arg);
          console.log(`  [${i}] ${display}`);
        }
      }
    } else {
      row('Function:', '(unknown)');
      console.log(`  Data: ${tx.input.slice(0, 74)}…`);
    }
  }

  if (transfers.length > 0) {
    sep('Token Transfers');
    for (const [i, t] of transfers.entries()) {
      console.log(
        `${i + 1}. ${t.symbol.padEnd(8)}  ${t.from.slice(0, 10)}… → ${t.to.slice(0, 10)}…  ${t.amount} ${t.symbol}`,
      );
    }
  }

  if (funcName?.toLowerCase().includes('swap')) {
    const isEthIn = funcName === 'swapExactETHForTokens';
    const soldTransfer = isEthIn
      ? null
      : transfers.find((t) => t.from.toLowerCase() === tx.from.toLowerCase());
    const received = transfers.find((t) => t.to.toLowerCase() === tx.from.toLowerCase());

    const soldLabel = isEthIn
      ? `${formatEther(tx.value)} ETH`
      : soldTransfer
        ? `${soldTransfer.amount} ${soldTransfer.symbol}`
        : null;
    const soldNum = isEthIn
      ? Number(tx.value) / 1e18
      : soldTransfer
        ? Number(soldTransfer.rawValue) / 10 ** soldTransfer.decimals
        : null;
    const receivedNum = received ? Number(received.rawValue) / 10 ** received.decimals : null;

    if (soldLabel && received && soldNum && receivedNum) {
      sep('Swap Summary');
      row('Sold:', soldLabel);
      row('Received:', `${received.amount} ${received.symbol}`);
      row(
        'Execution Price:',
        `${(soldNum / receivedNum).toFixed(4)} ${isEthIn ? 'ETH' : soldTransfer!.symbol}/${received.symbol}`,
      );
    }
  }

  if (traceResult) {
    sep('Internal Calls');
    renderCallTree(traceResult);
  } else if (showTrace) {
    sep('Internal Calls');
    console.log('(node does not support debug_traceTransaction)');
  }

  console.log('');
}

const cliArgs = process.argv.slice(2);
const txHash = cliArgs[0];
const rpcIdx = cliArgs.indexOf('--rpc');
const rpcUrl = rpcIdx >= 0 ? (cliArgs[rpcIdx + 1] ?? DEFAULT_RPC) : DEFAULT_RPC;
const showTrace = cliArgs.includes('--trace');
const fmtIdx = cliArgs.indexOf('--format');
const rawFmt = fmtIdx >= 0 ? (cliArgs[fmtIdx + 1] ?? 'text') : 'text';
const outputFormat: 'text' | 'json' = rawFmt === 'json' ? 'json' : 'text';

if (!txHash?.startsWith('0x')) {
  console.error(
    'Usage: npx tsx chain/analyzer.ts <tx_hash> [--rpc <url>] [--trace] [--format json|text]',
  );
  process.exit(1);
}

analyze(txHash, rpcUrl, showTrace, outputFormat).catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
