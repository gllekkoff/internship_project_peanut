import type { Venue } from '../tracker/tracker.interfaces';

/** Single execution leg of an arbitrage trade. All monetary values scaled by PRICE_SCALE. */
export class TradeLeg {
  constructor(
    readonly id: string,
    readonly timestamp: Date,
    readonly venue: Venue,
    readonly symbol: string,
    readonly side: 'buy' | 'sell',
    /** Base asset quantity, scaled by PRICE_SCALE. */
    readonly amount: bigint,
    /** Execution price, scaled by PRICE_SCALE. */
    readonly price: bigint,
    /** Fee paid, scaled by PRICE_SCALE. */
    readonly fee: bigint,
    readonly feeAsset: string,
  ) {}
}

/** Completed arbitrage trade consisting of a buy leg and a sell leg. */
export class ArbRecord {
  constructor(
    readonly id: string,
    readonly timestamp: Date,
    readonly buyLeg: TradeLeg,
    readonly sellLeg: TradeLeg,
    /** Gas cost in USD equivalent, scaled by PRICE_SCALE. Zero for CEX-only arb. */
    readonly gasCostUsd: bigint = 0n,
  ) {}

  /** Revenue from the price difference: (sellPrice - buyPrice) × amount. */
  get grossPnl(): bigint {
    return ((this.sellLeg.price - this.buyLeg.price) * this.buyLeg.amount) / PRICE_SCALE;
  }

  /** Sum of both leg fees plus gas cost. */
  get totalFees(): bigint {
    return this.buyLeg.fee + this.sellLeg.fee + this.gasCostUsd;
  }

  /** Gross PnL minus all fees. */
  get netPnl(): bigint {
    return this.grossPnl - this.totalFees;
  }

  /** Net PnL expressed in basis points of notional: netPnl / notional * 10000. */
  get netPnlBps(): bigint {
    if (this.notional === 0n) return 0n;
    return (this.netPnl * 10_000n) / this.notional;
  }

  /** Trade size in quote currency: buyPrice × amount. */
  get notional(): bigint {
    return (this.buyLeg.price * this.buyLeg.amount) / PRICE_SCALE;
  }
}

// Co-located here to avoid a circular import — ArbRecord's computed properties depend on it.
const PRICE_SCALE = 10n ** 8n;

/** Aggregate PnL summary across all recorded trades. */
export interface PnlSummary {
  readonly totalTrades: number;
  readonly totalPnlUsd: bigint;
  readonly totalFeesUsd: bigint;
  readonly avgPnlPerTrade: bigint;
  readonly avgPnlBps: bigint;
  /** Fraction of trades with positive net PnL, in [0, 1]. */
  readonly winRate: number;
  readonly bestTradePnl: bigint;
  readonly worstTradePnl: bigint;
  readonly totalNotional: bigint;
  /** Rough Sharpe estimate: mean(netPnl) / stddev(netPnl). NaN when stddev is zero. */
  readonly sharpeEstimate: number;
  /** Net PnL per UTC hour: { '14': totalPnl, ... } */
  readonly pnlByHour: Record<string, bigint>;
}

/** Compact trade summary used for CLI display. */
export interface TradeSummary {
  readonly id: string;
  readonly timestamp: Date;
  readonly symbol: string;
  readonly netPnl: bigint;
  readonly netPnlBps: bigint;
  readonly notional: bigint;
  readonly buyVenue: Venue;
  readonly sellVenue: Venue;
}
