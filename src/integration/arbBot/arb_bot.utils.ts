import { ArbRecord, TradeLeg } from '@/inventory/pnl/pnl.interfaces';
import { Venue } from '@/inventory/tracker/tracker.interfaces';
import { Direction, Signal } from '@/strategy/signal.interfaces';
import type { ExecutionContext } from '@/executor/engine/engine.interfaces';

/** Builds an ArbRecord from a signal for dry-run PnL tracking. */
export function signalToArbRecord(signal: Signal): ArbRecord {
  const [, quote = 'USDT'] = signal.pair.split('/');
  const isBuyCex = signal.direction === Direction.BUY_CEX_SELL_DEX;

  const buyLeg = new TradeLeg(
    `${signal.signalId}_buy`,
    signal.timestamp,
    isBuyCex ? Venue.BINANCE : Venue.WALLET,
    signal.pair,
    'buy',
    signal.size,
    isBuyCex ? signal.cexPrice : signal.dexPrice,
    signal.expectedFees,
    quote,
  );

  const sellLeg = new TradeLeg(
    `${signal.signalId}_sell`,
    signal.timestamp,
    isBuyCex ? Venue.WALLET : Venue.BINANCE,
    signal.pair,
    'sell',
    signal.size,
    isBuyCex ? signal.dexPrice : signal.cexPrice,
    0n,
    quote,
  );

  return new ArbRecord(signal.signalId, signal.timestamp, buyLeg, sellLeg);
}

/** Converts a completed ExecutionContext into an ArbRecord the PnLEngine can track. */
export function executionToArbRecord(ctx: ExecutionContext): ArbRecord {
  const { signal } = ctx;
  const [, quote = 'USDT'] = signal.pair.split('/');

  const isBuyCex = signal.direction === Direction.BUY_CEX_SELL_DEX;
  const buyVenue = isBuyCex ? Venue.BINANCE : Venue.WALLET;
  const sellVenue = isBuyCex ? Venue.WALLET : Venue.BINANCE;

  // Route fill data to buy/sell based on which leg executed at the buy venue.
  const buyIsLeg1 = (isBuyCex && ctx.leg1Venue === 'cex') || (!isBuyCex && ctx.leg1Venue === 'dex');
  const buyFillSize = buyIsLeg1 ? ctx.leg1FillSize : ctx.leg2FillSize;
  const buyFillPrice = buyIsLeg1 ? ctx.leg1FillPrice : ctx.leg2FillPrice;
  const sellFillSize = buyIsLeg1 ? ctx.leg2FillSize : ctx.leg1FillSize;
  const sellFillPrice = buyIsLeg1 ? ctx.leg2FillPrice : ctx.leg1FillPrice;

  const buyLeg = new TradeLeg(
    `${signal.signalId}_buy`,
    ctx.startedAt,
    buyVenue,
    signal.pair,
    'buy',
    buyFillSize ?? 0n,
    buyFillPrice ?? 0n,
    0n,
    quote,
  );

  const sellLeg = new TradeLeg(
    `${signal.signalId}_sell`,
    ctx.finishedAt ?? ctx.startedAt,
    sellVenue,
    signal.pair,
    'sell',
    sellFillSize ?? 0n,
    sellFillPrice ?? 0n,
    0n,
    quote,
  );

  return new ArbRecord(signal.signalId, ctx.startedAt, buyLeg, sellLeg);
}
