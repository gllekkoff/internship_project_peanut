#!/usr/bin/env tsx
/**
 * Order book analysis CLI.
 * Usage: npx tsx src/exchange/orderBook/orderBook.script.ts [SYMBOL] [--depth N]
 * Example: npx tsx src/exchange/orderBook/orderBook.script.ts ETH/USDT --depth 20
 */
import { config } from '@/configs/configs.service';
import { ExchangeClient } from '@/exchange/cexClient/exchange.client';
import { PRICE_SCALE } from '@/exchange/cexClient/exchange.constants';
import { OrderBookAnalyzer } from '@/exchange/orderBook/orderBook.analyzer';

// ── CLI arg parsing ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const symbol = args.find((a) => !a.startsWith('--')) ?? 'ETH/USDT';
const depthIdx = args.indexOf('--depth');
const depth = depthIdx !== -1 ? Number(args[depthIdx + 1]) : 20;

// ── Formatting helpers ─────────────────────────────────────────────────────────

const INNER_WIDTH = 54;

function toFloat(scaled: bigint, decimals = 2): string {
  const n = Number(scaled) / Number(PRICE_SCALE);
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function toQty(scaled: bigint): string {
  return (Number(scaled) / Number(PRICE_SCALE)).toFixed(1);
}

function line(content: string): string {
  const padded = content.padEnd(INNER_WIDTH);
  return `║  ${padded.slice(0, INNER_WIDTH - 2)}  ║`;
}

function divider(): string {
  return `╠${'═'.repeat(INNER_WIDTH + 2)}╣`;
}

function top(): string {
  return `╔${'═'.repeat(INNER_WIDTH + 2)}╗`;
}

function bottom(): string {
  return `╚${'═'.repeat(INNER_WIDTH + 2)}╝`;
}

function empty(): string {
  return line('');
}

// ── Main ───────────────────────────────────────────────────────────────────────

const client = new ExchangeClient(config.binance);
await client.connect();

const book = await client.fetchOrderBook(symbol, depth);
const analyzer = new OrderBookAnalyzer(book);

const ts = new Date(book.timestamp).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

// Walk-the-book for two representative sizes
const SMALL_QTY = 2;
const LARGE_QTY = 10;
const smallBuy = analyzer.walkTheBook('buy', SMALL_QTY);
const largeBuy = analyzer.walkTheBook('buy', LARGE_QTY);

// Depth within 10 bps
const BPS_DEPTH = 10;
const bidDepthQty = analyzer.depthAtBps('bid', BPS_DEPTH);
const askDepthQty = analyzer.depthAtBps('ask', BPS_DEPTH);
const bidDepthValue = (bidDepthQty * book.bestBid[0]) / PRICE_SCALE;
const askDepthValue = (askDepthQty * book.bestAsk[0]) / PRICE_SCALE;

const imbal = analyzer.imbalance(10);
const imbalSign = imbal > 0 ? '+' : '';
const imbalLabel =
  imbal > 0.1 ? 'slight buy pressure' : imbal < -0.1 ? 'slight sell pressure' : 'balanced';

const effSpread = analyzer.effectiveSpread(SMALL_QTY);

// Quoted spread in price and bps
const spreadPrice = book.bestAsk[0] - book.bestBid[0];

console.log(top());
console.log(line(`${symbol} Order Book Analysis`));
console.log(line(`Timestamp: ${ts}`));
console.log(divider());
console.log(line(`Best Bid:    $${toFloat(book.bestBid[0])} × ${toQty(book.bestBid[1])} ETH`));
console.log(line(`Best Ask:    $${toFloat(book.bestAsk[0])} × ${toQty(book.bestAsk[1])} ETH`));
console.log(line(`Mid Price:   $${toFloat(book.midPrice)}`));
console.log(line(`Spread:      $${toFloat(spreadPrice, 2)} (${book.spreadBps} bps)`));
console.log(divider());
console.log(line(`Depth (within ${BPS_DEPTH} bps):`));
console.log(line(`  Bids: ${toQty(bidDepthQty)} ETH ($${toFloat(bidDepthValue, 0)})`));
console.log(line(`  Asks: ${toQty(askDepthQty)} ETH ($${toFloat(askDepthValue, 0)})`));
console.log(line(`Imbalance: ${imbalSign}${imbal.toFixed(2)} (${imbalLabel})`));
console.log(divider());
console.log(line(`Walk-the-book (${SMALL_QTY} ETH buy):`));
console.log(line(`  Avg price:  $${toFloat(smallBuy.avgPrice)}`));
console.log(line(`  Slippage:   ${smallBuy.slippageBps} bps`));
console.log(line(`  Levels:     ${smallBuy.levelsConsumed}`));
console.log(empty());
console.log(line(`Walk-the-book (${LARGE_QTY} ETH buy):`));
console.log(line(`  Avg price:  $${toFloat(largeBuy.avgPrice)}`));
console.log(line(`  Slippage:   ${largeBuy.slippageBps} bps`));
console.log(line(`  Levels:     ${largeBuy.levelsConsumed}`));
console.log(divider());
console.log(line(`Effective spread (${SMALL_QTY} ETH round-trip): ${effSpread} bps`));
console.log(bottom());
