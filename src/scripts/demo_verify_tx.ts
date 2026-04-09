#!/usr/bin/env tsx
/**
 * Verifies that our pure-TypeScript AMM math matches a real historical swap.
 *
 * Strategy:
 *   1. Fetch the tx receipt and find the Uniswap V2 Swap event on the pair.
 *   2. Read the pair's reserves at (blockNumber - 1) — the state BEFORE the swap.
 *   3. Run UniswapV2Calculator.getAmountOut with those reserves.
 *   4. Compare our result with the actual on-chain amountOut from the Swap event.
 *
 * Usage:
 *   npx tsx src/scripts/demo_verify_tx.ts --tx <hash> --pair <address>
 *
 * Your pair addresses:
 *   ETH/USDC  0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc
 *   ETH/USDT  0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852
 */
import { createPublicClient, http, parseAbi, decodeEventLog } from 'viem';
import { mainnet } from 'viem/chains';
import type { Hex } from 'viem';
import { config } from '@/core/core.config';
import { UniswapV2Calculator } from '@/pricing/uniswap-v2/uniswap-v2.calculator';

const PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
]);

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const txIdx = args.indexOf('--tx');
const pairIdx = args.indexOf('--pair');

if (txIdx === -1 || pairIdx === -1) {
  console.error(
    'Usage: npx tsx src/scripts/demo_verify_tx.ts --tx <hash> --pair <address>\n' +
      '  ETH/USDC pair: 0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc\n' +
      '  ETH/USDT pair: 0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852',
  );
  process.exit(1);
}

const txHash = args[txIdx + 1] as Hex;
const pairAddr = args[pairIdx + 1] as Hex;

if (!txHash?.startsWith('0x') || !pairAddr?.startsWith('0x')) {
  console.error('Both --tx and --pair must be 0x-prefixed hex values.');
  process.exit(1);
}

// ── RPC client ──────────────────────────────────────────────────────────────
const client = createPublicClient({
  chain: mainnet,
  transport: http(config.mainnetRpcUrl),
});

// ── Fetch tx + receipt ──────────────────────────────────────────────────────
console.log(`\nFetching tx ${txHash}...`);
const receipt = await client.getTransactionReceipt({ hash: txHash });

if (receipt.status !== 'success') {
  console.error('Transaction reverted — no swap occurred.');
  process.exit(1);
}

// ── Find the Swap event emitted by the pair ─────────────────────────────────
const SWAP_TOPIC = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';

const swapLog = receipt.logs.find(
  (l) => l.address.toLowerCase() === pairAddr.toLowerCase() && l.topics[0] === SWAP_TOPIC,
);

if (!swapLog) {
  console.error(`No Swap event found from pair ${pairAddr} in this tx.`);
  console.error('Make sure you are using the correct --pair address for this transaction.');
  process.exit(1);
}

const { args: swapArgs } = decodeEventLog({ abi: PAIR_ABI, eventName: 'Swap', ...swapLog });
const { amount0In, amount1In, amount0Out, amount1Out } = swapArgs;

// Determine direction: exactly one side has input, exactly one side has output
const isToken0In = amount0In > 0n;
const amountIn = isToken0In ? amount0In : amount1In;
const amountOut = isToken0In ? amount1Out : amount0Out; // actual on-chain output

// ── Fetch token metadata ─────────────────────────────────────────────────────
const [token0Addr, token1Addr] = await Promise.all([
  client.readContract({ address: pairAddr, abi: PAIR_ABI, functionName: 'token0' }),
  client.readContract({ address: pairAddr, abi: PAIR_ABI, functionName: 'token1' }),
]);

// ── Fetch reserves at block BEFORE the swap ──────────────────────────────────
const blockBefore = receipt.blockNumber - 1n;
console.log(`Reading reserves at block ${blockBefore} (one block before the swap)...`);

const [reserve0, reserve1] = await client.readContract({
  address: pairAddr,
  abi: PAIR_ABI,
  functionName: 'getReserves',
  blockNumber: blockBefore,
});

const reserveIn = isToken0In ? reserve0 : reserve1;
const reserveOut = isToken0In ? reserve1 : reserve0;

// ── Run our calculator ───────────────────────────────────────────────────────
const FEE_BPS = 30n; // standard Uniswap V2
const calculated = UniswapV2Calculator.getAmountOut(amountIn, reserveIn, reserveOut, FEE_BPS);

// ── Print results ────────────────────────────────────────────────────────────
const tokenInAddr = isToken0In ? token0Addr : token1Addr;
const tokenOutAddr = isToken0In ? token1Addr : token0Addr;

console.log(`
Transaction  ${txHash}
Block        ${receipt.blockNumber}
Pair         ${pairAddr}

Direction    ${tokenInAddr} → ${tokenOutAddr}
             (${isToken0In ? 'token0' : 'token1'} → ${isToken0In ? 'token1' : 'token0'})

Reserves before swap (block ${blockBefore}):
  reserveIn  ${reserveIn}
  reserveOut ${reserveOut}

Amount in    ${amountIn}

On-chain amountOut  ${amountOut}
Our calculation     ${calculated}
Difference          ${amountOut - calculated}
Match               ${amountOut === calculated ? '✓ EXACT MATCH' : '✗ MISMATCH'}
`);

if (amountOut !== calculated) {
  console.error(
    'Mismatch detected. Possible reasons:\n' +
      '  - Wrong pair address (swap went through a different pool)\n' +
      '  - Multi-hop tx (intermediate amounts differ from input/output)\n' +
      '  - Non-standard fee (some forks use 25 bps instead of 30 bps)',
  );
  process.exit(1);
}
