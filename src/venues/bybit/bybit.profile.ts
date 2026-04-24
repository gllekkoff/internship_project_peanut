import { VenueId } from '@/venues/venue.interfaces';
import type { VenueProfile } from '@/venues/venue.interfaces';

/**
 * Bybit venue profile — stub only, not ready for trading.
 * Populate rate limits before enabling: https://bybit-exchange.github.io/docs/v5/rate-limit
 * Populate withdrawal fees before enabling: https://bybit-exchange.github.io/docs/v5/asset/withdraw/withdraw-record
 */
export const BYBIT_PROFILE: VenueProfile = {
  id: VenueId.BYBIT,
  displayName: 'Bybit',
  hydrated: false,

  rateLimit: {
    weightLimit: 0, // TODO: confirm Bybit rate limit
    windowMs: 60_000,
    weights: {
      orderBook: 0, // TODO: confirm per-endpoint weights
      balance: 0,
      createOrder: 0,
      cancelOrder: 0,
      fetchOrder: 0,
      tradingFees: 0,
    },
  },

  inventory: {
    withdrawalFees: {}, // TODO: populate per-asset withdrawal fees
    minOperatingBalance: {}, // TODO: set minimum operating balances
    rebalanceThresholdPct: 30,
  },

  trading: {
    combinedFeeRateBps: 40n, // TODO: verify Bybit fee structure
  },
};
