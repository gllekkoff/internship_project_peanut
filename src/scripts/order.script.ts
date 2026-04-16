#!/usr/bin/env tsx
/**
 * Place and cancel a limit order on Binance testnet.
 * Places a buy order at 10% below market price (won't fill), then cancels it.
 *
 * Usage: npx tsx src/scripts/order.script.ts [SYMBOL]
 * Example: npx tsx src/scripts/order.script.ts ETH/USDT
 *
 * Required env: BINANCE_TESTNET_API_KEY, BINANCE_TESTNET_SECRET
 */
import { config } from '@/configs/configs.service';
import { ExchangeClient } from '@/exchange/cexClient/exchange.client';
import { PRICE_SCALE } from '@/exchange/cexClient/exchange.constants';
import type { OrderResult } from '@/exchange/cexClient/exchange.interfaces';

const symbol = (process.argv[2] ?? 'ETH/USDT').toUpperCase();
const SEP = '═'.repeat(43);

function fmtPrice(v: bigint): string {
  return `$${(Number(v) / Number(PRICE_SCALE)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function printOrder(label: string, o: OrderResult): void {
  console.log(`\n${label}`);
  console.log(`  ID:        ${o.id}`);
  console.log(`  Symbol:    ${o.symbol}`);
  console.log(`  Side:      ${o.side.toUpperCase()}`);
  console.log(`  Type:      ${o.type.toUpperCase()} ${o.timeInForce}`);
  console.log(`  Amount:    ${(Number(o.amountRequested) / Number(PRICE_SCALE)).toFixed(4)}`);
  console.log(`  Price:     ${fmtPrice(o.avgFillPrice)}`);
  console.log(`  Status:    ${o.status.toUpperCase()}`);
  console.log(`  Filled:    ${(Number(o.amountFilled) / Number(PRICE_SCALE)).toFixed(4)}`);
}

const client = new ExchangeClient(config.binance);
await client.connect();

console.log(`\n${SEP}`);
console.log(`  ORDER DEMO: ${symbol} (Binance testnet)`);
console.log(SEP);

// ── 1. Fetch current market price ────────────────────────────────────────────
console.log('\n[1] Fetching current price...');
const book = await client.fetchOrderBook(symbol, 1);
const midPrice = Number(book.midPrice) / Number(PRICE_SCALE);
console.log(`  Mid price: $${midPrice.toFixed(2)}`);

// ── 2. Place limit buy 10% below market — safe, won't fill ───────────────────
const orderPrice = parseFloat((midPrice * 0.9).toFixed(2));
const orderAmount = 0.01;

console.log(
  `\n[2] Placing LIMIT BUY ${orderAmount} ${symbol.split('/')[0]} @ $${orderPrice} (10% below market)...`,
);
const placed = await client.createLimitOrder(symbol, 'buy', orderAmount, orderPrice);
printOrder('Order placed:', placed);

// ── 3. Cancel it ─────────────────────────────────────────────────────────────
console.log(`\n[3] Cancelling order ${placed.id}...`);
const cancelled = await client.cancelOrder(placed.id, symbol);
printOrder('Order cancelled:', cancelled);

console.log(`\n${SEP}\n`);
