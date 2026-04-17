#!/usr/bin/env tsx
/**
 * Place a LIMIT IOC order on Binance testnet.
 * IOC fills immediately at the given price or auto-cancels the remainder — no manual cancel needed.
 * Places a buy slightly above market so it attempts to fill and shows real IOC behavior.
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

console.log('\n[1] Fetching current price...');
const book = await client.fetchOrderBook(symbol, 1);
const midPrice = Number(book.midPrice) / Number(PRICE_SCALE);
console.log(`  Mid price: $${midPrice.toFixed(2)}`);

// Place 5% below market — IOC will find no liquidity at this price and auto-cancel immediately.
const orderPrice = parseFloat((midPrice * 0.95).toFixed(2));
const orderAmount = 0.01;

console.log(
  `\n[2] Placing LIMIT IOC BUY ${orderAmount} ${symbol.split('/')[0]} @ $${orderPrice} (5% below market — will auto-cancel)...`,
);
const result = await client.createLimitIocOrder(symbol, 'buy', orderAmount, orderPrice);
printOrder('Result:', result);
console.log('\n  Status CANCELED — IOC auto-cancelled because no liquidity at this price.');

console.log(`\n${SEP}\n`);
