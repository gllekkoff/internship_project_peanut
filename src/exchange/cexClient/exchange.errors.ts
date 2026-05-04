import { AppError } from '@/core/core.errors';

/** Failed to establish or verify connection to the exchange on init. */
export class ExchangeConnectionError extends AppError {}

/** API key or secret rejected by the exchange. */
export class ExchangeAuthError extends AppError {}

/** Request weight budget exhausted — caller should retry after the reset window. */
export class ExchangeRateLimitError extends AppError {}

/** Order placement, cancellation, or status check was rejected by the exchange. */
export class ExchangeOrderError extends AppError {}

/** Transient network failure communicating with the exchange. */
export class ExchangeNetworkError extends AppError {}

/** Raised when the WebSocket connection cannot be established or is lost beyond max retries. */
export class WsConnectionError extends AppError {}

/** Order rejected due to a Binance filter violation: LOT_SIZE (-1013), MIN_NOTIONAL (-1111), or PRICE_FILTER. */
export class ExchangeFilterError extends AppError {}
