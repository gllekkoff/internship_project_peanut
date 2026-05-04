import {
  binance,
  AuthenticationError,
  RateLimitExceeded,
  NetworkError,
  ExchangeError,
  InvalidOrder,
  InsufficientFunds,
  InvalidNonce,
} from 'ccxt';
import type {
  Order as CcxtOrder,
  OrderBook as CcxtOrderBook,
  Balances,
  OrderSide,
  OrderType,
  TradingFeeInterface,
} from 'ccxt';
import { PRICE_SCALE, PRICE_SCALE_NUM } from '@/core/core.constants';
import { makeLogger } from '@/core/core.logger';
import { fmtPrice } from '@/core/core.formatters';
import type { VenueProfile } from '@/venues/venue.interfaces';
import type {
  AssetBalance,
  ExchangeConfig,
  OrderBook,
  OrderResult,
  PriceLevel,
  TradingFees,
  TradingRules,
  WeightEntry,
} from './exchange.interfaces';
import {
  ExchangeAuthError,
  ExchangeConnectionError,
  ExchangeFilterError,
  ExchangeNetworkError,
  ExchangeOrderError,
  ExchangeRateLimitError,
  WsConnectionError,
} from './exchange.errors';
import type {
  OrderBookCallback,
  TradeCallback,
  TickerCallback,
  TradeEvent,
  TickerEvent,
  Subscription,
} from './exchange.interfaces';

const log = makeLogger('Exchange');

/** Converts a ccxt float price/quantity to a fixed-point bigint scaled by PRICE_SCALE. */
function toScaled(n: number | undefined): bigint {
  if (n === undefined || n === 0) return 0n;
  return BigInt(Math.round(n * Number(PRICE_SCALE)));
}

const WS_BASE = {
  mainnet: 'wss://stream.binance.com:9443',
  testnet: 'wss://stream.testnet.binance.vision',
};
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_MS = 500;
const WS_PING_INTERVAL_MS = 2 * 60 * 1_000;

/** Wraps ccxt Binance with rate limiting, error normalisation, and bigint monetary values. Also manages read-only WebSocket streams for market data. */
export class ExchangeClient {
  private readonly exchange: InstanceType<typeof binance>;
  private readonly weightLog: WeightEntry[] = [];
  private readonly profile: VenueProfile;

  private ws: WebSocket | null = null;
  private wsPingTimer: ReturnType<typeof setInterval> | null = null;
  private wsReconnectAttempts = 0;
  private wsStopped = false;
  private readonly wsBaseUrl: string;
  private readonly depthCallbacks: Map<string, Set<OrderBookCallback>> = new Map();
  private readonly tradeCallbacks: Map<string, Set<TradeCallback>> = new Map();
  private readonly tickerCallbacks: Map<string, Set<TickerCallback>> = new Map();
  private readonly books: Map<string, OrderBook> = new Map();

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
    this.wsBaseUrl = config.sandbox ? WS_BASE.testnet : WS_BASE.mainnet;
  }

  /** Validates connectivity by fetching server time. Must be called before any trading methods. */
  async connect(): Promise<void> {
    try {
      await this.exchange.fetchTime();
      log.info('Connected — server time synced');
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
    log.info(`fetchOrderBook ${symbol}  limit=${limit}`);

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

    log.info(
      `book ${symbol}  bid=${fmtPrice(bestBid[0])}  ask=${fmtPrice(bestAsk[0])}  spread=${spreadBpsFlt.toFixed(2)}bps`,
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

  async fetchBalance(): Promise<Record<string, AssetBalance>> {
    await this.checkWeight(this.profile.rateLimit.weights.balance);
    log.info('fetchBalance');

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
    log.info(`limitIOC ${side} ${amount} ${symbol} @ ${price}`);

    const raw = await this.callExchange<CcxtOrder>(() =>
      this.exchange.createOrder(symbol, 'limit' as OrderType, side as OrderSide, amount, price, {
        timeInForce: 'IOC',
      }),
    );
    this.recordWeight(this.profile.rateLimit.weights.createOrder);

    const result = this.normalizeOrder(raw);
    log.info(`order ${result.id}  status=${result.status}  filled=${result.amountFilled}`);
    return result;
  }

  /**
   * Places a market order. Fills immediately at best available price.
   * Prefer createLimitIocOrder for arbitrage — market orders have unpredictable slippage.
   */
  async createMarketOrder(symbol: string, side: string, amount: number): Promise<OrderResult> {
    await this.checkWeight(this.profile.rateLimit.weights.createOrder);
    log.info(`market ${side} ${amount} ${symbol}`);

    const raw = await this.callExchange<CcxtOrder>(() =>
      this.exchange.createOrder(symbol, 'market' as OrderType, side as OrderSide, amount),
    );
    this.recordWeight(this.profile.rateLimit.weights.createOrder);

    const result = this.normalizeOrder(raw);
    log.info(`order ${result.id}  status=${result.status}  filled=${result.amountFilled}`);
    return result;
  }

  /** Cancels an open order by ID. Returns the order state after cancellation. */
  async cancelOrder(orderId: string, symbol: string): Promise<OrderResult> {
    await this.checkWeight(this.profile.rateLimit.weights.cancelOrder);
    log.info(`cancelOrder ${orderId} ${symbol}`);

    const raw = await this.callExchange<CcxtOrder>(() =>
      this.exchange.cancelOrder(orderId, symbol),
    );
    this.recordWeight(this.profile.rateLimit.weights.cancelOrder);

    const result = this.normalizeOrder(raw);
    log.info(`order ${orderId} cancelled — status=${result.status}`);
    return result;
  }

  /** Returns the current status of an order. */
  async fetchOrderStatus(orderId: string, symbol: string): Promise<OrderResult> {
    await this.checkWeight(this.profile.rateLimit.weights.fetchOrder);
    log.info(`fetchOrderStatus ${orderId} ${symbol}`);

    const raw = await this.callExchange<CcxtOrder>(() => this.exchange.fetchOrder(orderId, symbol));
    this.recordWeight(this.profile.rateLimit.weights.fetchOrder);

    const result = this.normalizeOrder(raw);
    log.info(`order ${orderId}  status=${result.status}`);
    return result;
  }

  /** Returns maker/taker fee rates for the given symbol, scaled by PRICE_SCALE. */
  async getTradingFees(symbol: string): Promise<TradingFees> {
    await this.checkWeight(this.profile.rateLimit.weights.tradingFees);
    log.info(`getTradingFees ${symbol}`);

    const raw = await this.callExchange<TradingFeeInterface>(() =>
      this.exchange.fetchTradingFee(symbol),
    );
    this.recordWeight(this.profile.rateLimit.weights.tradingFees);

    const fees: TradingFees = {
      maker: toScaled(raw.maker ?? 0.001),
      taker: toScaled(raw.taker ?? 0.001),
    };

    log.info(`fees ${symbol}  maker=${fees.maker}  taker=${fees.taker}`);
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

  /** Fetches LOT_SIZE, PRICE_FILTER, and MIN_NOTIONAL rules for a symbol from the exchange. */
  async fetchTradingRules(symbol: string): Promise<TradingRules> {
    const markets = await this.callExchange(() => this.exchange.fetchMarkets());
    const market = markets.find((m) => m?.symbol === symbol);
    if (!market) throw new ExchangeFilterError(`No market found for symbol: ${symbol}`);

    type BinanceFilter = {
      filterType: string;
      stepSize?: string;
      tickSize?: string;
      minNotional?: string;
    };
    const filters = (market.info as { filters?: BinanceFilter[] } | undefined)?.filters ?? [];

    const lotFilter = filters.find((f) => f.filterType === 'LOT_SIZE');
    const priceFilter = filters.find((f) => f.filterType === 'PRICE_FILTER');
    // Binance renamed MIN_NOTIONAL → NOTIONAL in some pairs; check both.
    const notionalFilter =
      filters.find((f) => f.filterType === 'MIN_NOTIONAL') ??
      filters.find((f) => f.filterType === 'NOTIONAL');

    const rules: TradingRules = {
      symbol,
      stepSize: toScaled(parseFloat(lotFilter?.stepSize ?? '0.001')),
      tickSize: toScaled(parseFloat(priceFilter?.tickSize ?? '0.01')),
      minNotional: toScaled(parseFloat(notionalFilter?.minNotional ?? '5')),
    };

    const s = PRICE_SCALE_NUM;
    log.info(
      `tradingRules ${symbol}` +
        `  stepSize=${(Number(rules.stepSize) / s).toFixed(6)}` +
        `  tickSize=$${(Number(rules.tickSize) / s).toFixed(4)}` +
        `  minNotional=$${(Number(rules.minNotional) / s).toFixed(2)}`,
    );
    return rules;
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
      if (e instanceof InvalidNonce)
        throw new ExchangeNetworkError(`Clock skew detected: ${e.message}`);
      // InvalidOrder covers LOT_SIZE (-1013), MIN_NOTIONAL (-1111), and PRICE_FILTER violations.
      if (e instanceof InvalidOrder) throw new ExchangeFilterError(e.message);
      if (e instanceof InsufficientFunds) throw new ExchangeOrderError(e.message);
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
      log.warn(
        `Rate limit: weight ${used}/${this.profile.rateLimit.weightLimit} — sleeping ${sleepMs}ms`,
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

  /** Opens the combined WebSocket stream for all registered subscriptions. Call after all subscribe* calls. */
  connectWs(): void {
    this.wsStopped = false;
    this.openSocket();
  }

  /** Closes the WebSocket and stops all reconnection attempts. */
  disconnectWs(): void {
    this.wsStopped = true;
    if (this.wsPingTimer !== null) {
      clearInterval(this.wsPingTimer);
      this.wsPingTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  /** Returns the latest cached order book for the pair, or null if not yet received. */
  getBook(pair: string): OrderBook | null {
    return this.books.get(pair) ?? null;
  }

  /** Subscribes to L2 order book depth updates for the pair. */
  subscribeDepth(pair: string, cb: OrderBookCallback): Subscription {
    return this.addWsCallback(this.depthCallbacks, pair, cb);
  }

  /** Subscribes to individual trade events for the pair. */
  subscribeTrades(pair: string, cb: TradeCallback): Subscription {
    return this.addWsCallback(this.tradeCallbacks, pair, cb);
  }

  /** Subscribes to 24h mini-ticker updates for the pair. */
  subscribeTicker(pair: string, cb: TickerCallback): Subscription {
    return this.addWsCallback(this.tickerCallbacks, pair, cb);
  }

  private openSocket(): void {
    const streams = this.buildStreamList();
    if (streams.length === 0) {
      throw new WsConnectionError(
        'No subscriptions registered — call subscribe* before connectWs()',
      );
    }

    const url = `${this.wsBaseUrl}/stream?streams=${streams.join('/')}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.wsReconnectAttempts = 0;
      log.info(`WS connected — ${streams.length} streams`);
      this.wsPingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          // Node.js ws library exposes ping(); browser WebSocket does not — guard for both envs.
          (this.ws as unknown as { ping?: () => void }).ping?.();
        }
      }, WS_PING_INTERVAL_MS);
    };

    this.ws.onmessage = (event) => {
      try {
        this.handleWsMessage(event.data as string);
      } catch (e) {
        log.error(`WS parse error: ${e instanceof Error ? e.message : String(e)}`);
      }
    };

    this.ws.onerror = (event) => {
      const msg = (event as unknown as { message?: string }).message ?? String(event);
      log.warn(`WS error: ${msg}`);
    };

    this.ws.onclose = (event) => {
      if (this.wsPingTimer !== null) {
        clearInterval(this.wsPingTimer);
        this.wsPingTimer = null;
      }
      if (this.wsStopped) {
        log.info(`WS closed: code=${event.code}`);
      } else {
        log.warn(`WS closed: code=${event.code}, reason=${event.reason || 'none'} — reconnecting`);
        this.scheduleReconnect();
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.wsReconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log.error('WS max reconnect attempts reached — giving up');
      return;
    }

    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.wsReconnectAttempts, 30_000);
    this.wsReconnectAttempts++;
    log.warn(`WS reconnecting in ${delay}ms (attempt ${this.wsReconnectAttempts})`);
    setTimeout(() => {
      if (!this.wsStopped) this.openSocket();
    }, delay);
  }

  private handleWsMessage(raw: string): void {
    const msg = JSON.parse(raw) as { stream: string; data: unknown };
    const { stream, data } = msg;
    if (stream.endsWith('@depth20@100ms')) {
      const pair = wsStreamToPair(stream.replace('@depth20@100ms', ''));
      const book = wsParseDepth(pair, data);
      this.books.set(pair, book);
      this.depthCallbacks.get(pair)?.forEach((cb) => cb(book));
    } else if (stream.endsWith('@trade')) {
      const pair = wsStreamToPair(stream.replace('@trade', ''));
      const trade = wsParseTrade(pair, data);
      this.tradeCallbacks.get(pair)?.forEach((cb) => cb(trade));
    } else if (stream.endsWith('@miniTicker')) {
      const pair = wsStreamToPair(stream.replace('@miniTicker', ''));
      const ticker = wsParseTicker(pair, data);
      this.tickerCallbacks.get(pair)?.forEach((cb) => cb(ticker));
    }
  }

  private buildStreamList(): string[] {
    const streams: string[] = [];
    for (const pair of this.depthCallbacks.keys())
      streams.push(`${wsPairToStream(pair)}@depth20@100ms`);
    for (const pair of this.tradeCallbacks.keys()) streams.push(`${wsPairToStream(pair)}@trade`);
    for (const pair of this.tickerCallbacks.keys())
      streams.push(`${wsPairToStream(pair)}@miniTicker`);
    return [...new Set(streams)];
  }

  private addWsCallback<T>(map: Map<string, Set<T>>, pair: string, cb: T): Subscription {
    if (!map.has(pair)) map.set(pair, new Set());
    map.get(pair)!.add(cb); // validated by has() above
    return { unsubscribe: () => map.get(pair)?.delete(cb) };
  }
}

function wsPairToStream(pair: string): string {
  return pair.replace('/', '').toLowerCase();
}

function wsStreamToPair(symbol: string): string {
  const s = symbol.toUpperCase();
  for (const quote of ['USDT', 'USDC', 'BUSD', 'TUSD']) {
    if (s.endsWith(quote)) return `${s.slice(0, -quote.length)}/${quote}`;
  }
  for (const quote of ['ETH', 'BTC', 'BNB']) {
    if (s.endsWith(quote) && s.length > quote.length)
      return `${s.slice(0, -quote.length)}/${quote}`;
  }
  return s;
}

function wsParseDecimal(s: string): bigint {
  const dot = s.indexOf('.');
  if (dot === -1) return BigInt(s) * PRICE_SCALE;
  const intPart = s.slice(0, dot);
  const fracPart = s
    .slice(dot + 1)
    .padEnd(8, '0')
    .slice(0, 8);
  return BigInt(intPart === '' ? '0' : intPart) * PRICE_SCALE + BigInt(fracPart);
}

function wsParseDepth(pair: string, data: unknown): OrderBook {
  const d = data as { lastUpdateId: number; bids: [string, string][]; asks: [string, string][] };
  const bids: [bigint, bigint][] = d.bids.map(([p, q]) => [wsParseDecimal(p), wsParseDecimal(q)]);
  const asks: [bigint, bigint][] = d.asks.map(([p, q]) => [wsParseDecimal(p), wsParseDecimal(q)]);
  const bestBid = bids[0] ?? [0n, 0n];
  const bestAsk = asks[0] ?? [0n, 0n];
  const midPrice = bestBid[0] > 0n && bestAsk[0] > 0n ? (bestBid[0] + bestAsk[0]) / 2n : 0n;
  const spreadBps = midPrice > 0n ? ((bestAsk[0] - bestBid[0]) * 10_000n) / midPrice : 0n;
  return { symbol: pair, timestamp: Date.now(), bids, asks, bestBid, bestAsk, midPrice, spreadBps };
}

function wsParseTrade(pair: string, data: unknown): TradeEvent {
  const d = data as { t: number; p: string; q: string; T: number; m: boolean };
  return {
    symbol: pair,
    tradeId: d.t,
    price: wsParseDecimal(d.p),
    quantity: wsParseDecimal(d.q),
    timestamp: d.T,
    isBuyerMaker: d.m,
  };
}

function wsParseTicker(pair: string, data: unknown): TickerEvent {
  const d = data as { E: number; c: string; o: string; h: string; l: string; v: string; q: string };
  return {
    symbol: pair,
    lastPrice: wsParseDecimal(d.c),
    openPrice: wsParseDecimal(d.o),
    highPrice: wsParseDecimal(d.h),
    lowPrice: wsParseDecimal(d.l),
    volume: wsParseDecimal(d.v),
    quoteVolume: BigInt(Math.round(parseFloat(d.q) * PRICE_SCALE_NUM)),
    timestamp: d.E,
  };
}
