import { VenueId } from '@/venues/venue.interfaces';
import type { VenueProfile } from '@/venues/venue.interfaces';

/**
 * Static Binance venue profile — all rate limits, fees, and inventory thresholds in one place.
 * withdrawalFee values are testnet estimates; call VenueHydrator.hydrate() at startup
 * to overwrite them with live exchange data.
 */
export const BINANCE_PROFILE: VenueProfile = {
  id: VenueId.BINANCE,
  displayName: 'Binance',
  hydrated: false,

  rateLimit: {
    weightLimit: 1100, // Binance hard limit is 1200/min; 1100 keeps a safety buffer
    windowMs: 60_000,
    weights: {
      orderBook: 1,
      balance: 10,
      createOrder: 1,
      cancelOrder: 1,
      fetchOrder: 2,
      tradingFees: 1,
    },
  },

  inventory: {
    withdrawalFees: {
      ETH: {
        withdrawalFee: 500_000n, // 0.005 ETH — overwritten by hydrator
        minWithdrawal: 1_000_000n, // 0.01 ETH
        confirmations: 12,
        estimatedTimeMin: 15,
      },
      USDT: {
        withdrawalFee: 100_000_000n, // 1.0 USDT — overwritten by hydrator
        minWithdrawal: 1_000_000_000n, // 10.0 USDT
        confirmations: 12,
        estimatedTimeMin: 15,
      },
      USDC: {
        withdrawalFee: 100_000_000n, // 1.0 USDC — overwritten by hydrator
        minWithdrawal: 1_000_000_000n, // 10.0 USDC
        confirmations: 12,
        estimatedTimeMin: 15,
      },
    },
    minOperatingBalance: {
      ETH: 50_000_000n, // 0.5 ETH
      USDT: 50_000_000_000n, // 500 USDT
      USDC: 50_000_000_000n, // 500 USDC
    },
    rebalanceThresholdPct: 30,
  },

  trading: {
    combinedFeeRateBps: 40n, // ~40 bps total across both legs
  },
};
