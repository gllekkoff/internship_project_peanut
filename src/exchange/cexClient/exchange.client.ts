import { binance, AuthenticationError, RateLimitExceeded, NetworkError, ExchangeError } from 'ccxt';
import type {
  Order as CcxtOrder,
  OrderBook as CcxtOrderBook,
  Balances,
  OrderSide,
  OrderType,
  TradingFeeInterface,
} from 'ccxt';
import { PRICE_SCALE, PRICE_SCALE_NUM } from '@/core/core.constants';
import type { VenueProfile } from '@/venues/venue.interfaces';
import type {
  AssetBalance,
  ExchangeConfig,
  OrderBook,
  OrderResult,
  PriceLevel,
  TradingFees,
  WeightEntry,
} from './exchange.interfaces';
import {
  ExchangeAuthError,
  ExchangeConnectionError,
  ExchangeNetworkError,
  ExchangeOrderError,
  ExchangeRateLimitError,
} from './exchange.errors';

/** Converts a ccxt float price/quantity to a fixed-point bigint scaled by PRICE_SCALE. */
function toScaled(n: number | undefined): bigint {
  if (n === undefined || n === 0) return 0n;
  return BigInt(Math.round(n * Number(PRICE_SCALE)));
}

/** Wraps ccxt Binance with rate limiting, error normalisation, and bigint monetary values. */
export class ExchangeClient {
  private readonly exchange: InstanceType<typeof binance>;
  private readonly weightLog: WeightEntry[] = [];
  private readonly profile: VenueProfile;

  /**
   * Constructs the client; throws ExchangeAuthError immediately if credentials are absent.
   * Call connect() to validate live connectivity before trading.
   */
  constructor(config: ExchangeConfig, profile: VenueProfile) {
    if (!config.apiKey || !config.secret) {
      throw new ExchangeAuthError('BINANCE_TESTNET_API_KEY and BINANCE_TESTNET_SECRET must be set');
    }

    this.exchange = new binance({
      apiKey: config.apiKey,
      secret: config.secret,
      sandbox: config.sandbox,
      options: { ...config.options },
      enableRateLimit: config.enableRateLimit,
    });
    this.profile = profile;
  }

  /** Validates connectivity by fetching server time. Must be called before any trading methods. */
  async connect(): Promise<void> {
    try {
      await this.exchange.fetchTime();
      console.log('[ExchangeClient] connected — server time synced');
    } catch (e) {
      if (e instanceof AuthenticationError) {
        throw new ExchangeAuthError(`Authentication failed: ${e.message}`);
      }
      throw new ExchangeConnectionError(`Connection health check failed: ${String(e)}`);
    }
  }

  /** Fetches an L2 order book snapshot for `symbol` with up to `limit` price levels per side. */
  async fetchOrderBook(symbol: string, limit: number = 20): Promise<OrderBook> {
    await this.checkWeight(this.profile.rateLimit.weights.orderBook);
    console.log(`[ExchangeClient] fetchOrderBook ${symbol} limit=${limit}`);

    const raw = await this.callExchange<CcxtOrderBook>(() =>
      this.exchange.fetchOrderBook(symbol, limit),
    );
    this.recordWeight(this.profile.rateLimit.weights.orderBook);

    const bids: PriceLevel[] = raw.bids.map(([p, q]) => [toScaled(p), toScaled(q)]);
    const asks: PriceLevel[] = raw.asks.map(([p, q]) => [toScaled(p), toScaled(q)]);

    const bestBid = bids[0];
    const bestAsk = asks[0];
    if (!bestBid || !bestAsk) throw new ExchangeOrderError(`${symbol} order book is empty`);

    const midPrice = (bestBid[0] + bestAsk[0]) / 2n;
    // spreadBps = (ask - bid) / mid * 10000; multiply before dividing to avoid bigint truncation.
    const spreadBps = midPrice > 0n ? ((bestAsk[0] - bestBid[0]) * 10_000n) / midPrice : 0n;
    // Float version for display — bigint division truncates sub-1-bps spreads to 0 on liquid pairs.
    const spreadBpsFlt =
      midPrice > 0n ? (Number(bestAsk[0] - bestBid[0]) / Number(midPrice)) * 10_000 : 0;

    const fmt = (v: bigint) => (Number(v) / PRICE_SCALE_NUM).toFixed(2);
    console.log(
      `[ExchangeClient] orderBook ${symbol} bid=$${fmt(bestBid[0])} ask=$${fmt(bestAsk[0])} spread=${spreadBpsFlt.toFixed(2)}bps`,
    );

    return {
      symbol,
      timestamp: raw.timestamp ?? Date.now(),
      bids,
      asks,
      bestBid,
      bestAsk,
      midPrice,
      spreadBps,
    };
  }

  /** Fetches account balances; filters out zero-balance assets. */
  async fetchBalance(): Promise<Record<string, AssetBalance>> {
    await this.checkWeight(this.profile.rateLimit.weights.balance);
    console.log('[ExchangeClient] fetchBalance');

    const raw = await this.callExchange<Balances>(() => this.exchange.fetchBalance());
    this.recordWeight(this.profile.rateLimit.weights.balance);

    const result: Record<string, AssetBalance> = {};

    for (const [asset, bal] of Object.entries(raw)) {
      // Balances also contains metadata keys (info, timestamp, datetime) — skip non-objects.
      if (typeof bal !== 'object' || bal === null || !('total' in bal)) continue;
      const total = toScaled(bal.total ?? 0);
      if (total === 0n) continue;
      result[asset] = { free: toScaled(bal.free ?? 0), locked: toScaled(bal.used ?? 0), total };
    }

    console.log(`[ExchangeClient] balance: ${Object.keys(result).length} non-zero assets`);
    return result;
  }

  /** Places a LIMIT IOC order — fills immediately at price or cancels the remainder. */
  async createLimitIocOrder(
    symbol: string,
    side: string,
    amount: number,
    price: number,
  ): Promise<OrderResult> {
    await this.checkWeight(this.profile.rateLimit.weights.createOrder);
    console.log(`[ExchangeClient] createLimitIocOrder ${side} ${amount} ${symbol} @ ${price}`);

    const raw = await this.callExchange<CcxtOrder>(() =>
      this.exchange.createOrder(symbol, 'limit' as OrderType, side as OrderSide, amount, price, {
        timeInForce: 'IOC',
      }),
    );
    this.recordWeight(this.profile.rateLimit.weights.createOrder);

    const result = this.normalizeOrder(raw);
    console.log(
      `[ExchangeClient] order ${result.id} status=${result.status} filled=${result.amountFilled}`,
    );
    return result;
  }

  /**
   * Places a market order. Fills immediately at best available price.
   * Prefer createLimitIocOrder for arbitrage — market orders have unpredictable slippage.
   */
  async createMarketOrder(symbol: string, side: string, amount: number): Promise<OrderResult> {
    await this.checkWeight(this.profile.rateLimit.weights.createOrder);
    console.log(`[ExchangeClient] createMarketOrder ${side} ${amount} ${symbol}`);

    const raw = await this.callExchange<CcxtOrder>(() =>
      this.exchange.createOrder(symbol, 'market' as OrderType, side as OrderSide, amount),
    );
    this.recordWeight(this.profile.rateLimit.weights.createOrder);

    const result = this.normalizeOrder(raw);
    console.log(
      `[ExchangeClient] order ${result.id} status=${result.status} filled=${result.amountFilled}`,
    );
    return result;
  }

  /** Cancels an open order by ID. Returns the order state after cancellation. */
  async cancelOrder(orderId: string, symbol: string): Promise<OrderResult> {
    await this.checkWeight(this.profile.rateLimit.weights.cancelOrder);
    console.log(`[ExchangeClient] cancelOrder ${orderId} ${symbol}`);

    const raw = await this.callExchange<CcxtOrder>(() =>
      this.exchange.cancelOrder(orderId, symbol),
    );
    this.recordWeight(this.profile.rateLimit.weights.cancelOrder);

    const result = this.normalizeOrder(raw);
    console.log(`[ExchangeClient] order ${orderId} cancelled — status=${result.status}`);
    return result;
  }

  /** Returns the current status of an order. */
  async fetchOrderStatus(orderId: string, symbol: string): Promise<OrderResult> {
    await this.checkWeight(this.profile.rateLimit.weights.fetchOrder);
    console.log(`[ExchangeClient] fetchOrderStatus ${orderId} ${symbol}`);

    const raw = await this.callExchange<CcxtOrder>(() => this.exchange.fetchOrder(orderId, symbol));
    this.recordWeight(this.profile.rateLimit.weights.fetchOrder);

    const result = this.normalizeOrder(raw);
    console.log(`[ExchangeClient] order ${orderId} status=${result.status}`);
    return result;
  }

  /** Returns maker/taker fee rates for the given symbol, scaled by PRICE_SCALE. */
  async getTradingFees(symbol: string): Promise<TradingFees> {
    await this.checkWeight(this.profile.rateLimit.weights.tradingFees);
    console.log(`[ExchangeClient] getTradingFees ${symbol}`);

    const raw = await this.callExchange<TradingFeeInterface>(() =>
      this.exchange.fetchTradingFee(symbol),
    );
    this.recordWeight(this.profile.rateLimit.weights.tradingFees);

    const fees: TradingFees = {
      maker: toScaled(raw.maker ?? 0.001),
      taker: toScaled(raw.taker ?? 0.001),
    };

    console.log(`[ExchangeClient] fees ${symbol} maker=${fees.maker} taker=${fees.taker}`);
    return fees;
  }

  /** Fetches withdrawal fees for all assets from the exchange; returns amounts scaled by PRICE_SCALE. Returns empty object on sandbox/testnet where the endpoint is unavailable. */
  async fetchWithdrawalFees(): Promise<Record<string, bigint>> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (this.exchange as any).fetchWithdrawalFees !== 'function') return {};
    const raw = await this.callExchange<Record<string, unknown>>(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.exchange as any).fetchWithdrawalFees(),
    );
    const result: Record<string, bigint> = {};
    for (const [asset, info] of Object.entries(raw)) {
      const fee =
        typeof info === 'object' && info !== null && 'fee' in info
          ? (info as Record<string, unknown>)['fee']
          : info;
      if (typeof fee === 'number' && fee > 0) {
        result[asset] = toScaled(fee);
      }
    }
    return result;
  }

  /**
   * Wraps a ccxt call and maps ccxt error classes to domain errors.
   * Non-retryable errors (rejected orders, bad symbols) propagate immediately.
   */
  private async callExchange<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AuthenticationError) throw new ExchangeAuthError(e.message);
      if (e instanceof RateLimitExceeded) throw new ExchangeRateLimitError(e.message);
      if (e instanceof NetworkError) throw new ExchangeNetworkError(e.message);
      if (e instanceof ExchangeError) throw new ExchangeOrderError(e.message);
      throw new ExchangeNetworkError(String(e));
    }
  }

  /** Converts a raw ccxt Order into a normalised OrderResult with bigint monetary values. */
  private normalizeOrder(raw: CcxtOrder): OrderResult {
    return {
      id: raw.id,
      symbol: raw.symbol,
      side: raw.side ?? 'unknown',
      type: raw.type ?? 'unknown',
      timeInForce: raw.timeInForce ?? 'GTC',
      amountRequested: toScaled(raw.amount),
      amountFilled: toScaled(raw.filled),
      avgFillPrice: toScaled(raw.average ?? raw.price),
      fee: toScaled(raw.fee?.cost),
      feeAsset: raw.fee?.currency ?? '',
      status: raw.status ?? 'unknown',
      timestamp: raw.timestamp ?? Date.now(),
    };
  }

  /**
   * Checks whether adding `weight` would exceed the rate limit window.
   * Sleeps until capacity frees up if the budget is tight.
   */
  private async checkWeight(weight: number): Promise<void> {
    this.pruneWeightLog();
    const used = this.weightLog.reduce((sum, e) => sum + e.weight, 0);
    if (used + weight < this.profile.rateLimit.weightLimit) return;

    const oldest = this.weightLog[0];
    if (!oldest) return;

    const sleepMs = this.profile.rateLimit.windowMs - (Date.now() - oldest.time) + 50;
    if (sleepMs > 0) {
      console.warn(
        `[ExchangeClient] weight budget tight (${used}/${this.profile.rateLimit.weightLimit}) — sleeping ${sleepMs}ms`,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
      this.pruneWeightLog();
    }
  }

  private recordWeight(weight: number): void {
    this.weightLog.push({ time: Date.now(), weight });
  }

  private pruneWeightLog(): void {
    const cutoff = Date.now() - this.profile.rateLimit.windowMs;
    while (this.weightLog.length > 0 && this.weightLog[0]!.time < cutoff) {
      this.weightLog.shift();
    }
  }
}
