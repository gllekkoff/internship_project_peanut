import type { Token, Address } from '@/core/core.types';

/** Direction of an arbitrage trade relative to each venue. */
export enum Direction {
  BUY_CEX_SELL_DEX = 'buy_cex_sell_dex',
  BUY_DEX_SELL_CEX = 'buy_dex_sell_cex',
}

/** Constructor parameters for a Signal — all fields required at creation time. */
export interface SignalParams {
  readonly signalId: string;
  readonly pair: string;
  readonly direction: Direction;
  /** CEX price used for this leg, scaled by PRICE_SCALE (1e8). */
  readonly cexPrice: bigint;
  /** DEX effective execution price, scaled by PRICE_SCALE (1e8). */
  readonly dexPrice: bigint;
  /** Raw price gap between venues in basis points. */
  readonly spreadBps: number;
  /** Trade size in base asset, scaled by PRICE_SCALE (1e8). */
  readonly size: bigint;
  /** Expected gross profit in quote currency, scaled by PRICE_SCALE. */
  readonly expectedGrossPnl: bigint;
  /** Expected total fees in quote currency, scaled by PRICE_SCALE. */
  readonly expectedFees: bigint;
  /** Expected net profit after fees in quote currency, scaled by PRICE_SCALE. */
  readonly expectedNetPnl: bigint;
  /** Composite score: higher is better. Negative means do not trade. */
  readonly score: number;
  readonly timestamp: Date;
  readonly expiry: Date;
  readonly inventoryOk: boolean;
  readonly withinLimits: boolean;
}

/** Immutable arbitrage signal with pricing, PnL estimate, and time-bounded validity. */
export class Signal {
  readonly signalId: string;
  readonly pair: string;
  readonly direction: Direction;
  readonly cexPrice: bigint;
  readonly dexPrice: bigint;
  readonly spreadBps: number;
  readonly size: bigint;
  readonly expectedGrossPnl: bigint;
  readonly expectedFees: bigint;
  readonly expectedNetPnl: bigint;
  readonly score: number;
  readonly timestamp: Date;
  readonly expiry: Date;
  readonly inventoryOk: boolean;
  readonly withinLimits: boolean;

  constructor(params: SignalParams) {
    this.signalId = params.signalId;
    this.pair = params.pair;
    this.direction = params.direction;
    this.cexPrice = params.cexPrice;
    this.dexPrice = params.dexPrice;
    this.spreadBps = params.spreadBps;
    this.size = params.size;
    this.expectedGrossPnl = params.expectedGrossPnl;
    this.expectedFees = params.expectedFees;
    this.expectedNetPnl = params.expectedNetPnl;
    this.score = params.score;
    this.timestamp = params.timestamp;
    this.expiry = params.expiry;
    this.inventoryOk = params.inventoryOk;
    this.withinLimits = params.withinLimits;
  }

  /** True when the signal has not expired and all pre-trade checks pass. */
  isValid(): boolean {
    return (
      Date.now() < this.expiry.getTime() &&
      this.inventoryOk &&
      this.withinLimits &&
      this.expectedNetPnl > 0n &&
      this.score > 0
    );
  }

  /** Seconds elapsed since this signal was created. */
  ageSeconds(): number {
    return (Date.now() - this.timestamp.getTime()) / 1_000;
  }
}

/** Configuration for SignalGenerator thresholds and DEX pricing integration. */
export interface SignalGeneratorConfig {
  readonly minSpreadBps?: number;
  /** Minimum net profit to emit a signal, scaled by PRICE_SCALE. */
  readonly minProfit?: bigint;
  /** Maximum position size in quote currency, scaled by PRICE_SCALE. */
  readonly maxPosition?: bigint;
  readonly signalTtlMs?: number;
  readonly cooldownMs?: number;
  /**
   * Resolves pair strings (e.g. 'ETH/USDT') to [baseToken, quoteToken].
   * Required for real DEX pricing — without it the generator falls back to a CEX-mid stub.
   */
  readonly pairTokens?: Map<string, readonly [Token, Token]>;
  /** Required for PricingEngine.getQuote fork simulation calls. */
  readonly senderAddress?: Address;
}

/** Live price snapshot from both venues, used internally during signal generation. */
export interface PriceLevels {
  readonly cexBid: bigint;
  readonly cexAsk: bigint;
  /** Quote you pay per base unit on DEX (PRICE_SCALE). */
  readonly dexBuyPrice: bigint;
  /** Quote you receive per base unit on DEX (PRICE_SCALE). */
  readonly dexSellPrice: bigint;
}
