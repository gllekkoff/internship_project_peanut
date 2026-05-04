import { VenueId } from '@/venues/venue.interfaces';
import type { VenueProfile } from '@/venues/venue.interfaces';

/**
 * Returns the Binance venue profile for the given environment.
 * Production uses tight operating balances and real fees; testnet uses relaxed thresholds and zero fees.
 * withdrawalFee values are overwritten by VenueHydrator.hydrate() at startup with live data.
 */
export function getBinanceProfile(production: boolean): VenueProfile {
  return {
    id: VenueId.BINANCE,
    displayName: production ? 'Binance' : 'Binance Testnet',
    hydrated: false,

    rateLimit: {
      weightLimit: 1100,
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
      minOperatingBalance: production
        ? {
            ETH: 50_000_000n, // 0.5 ETH
            USDT: 50_000_000_000n, // 500 USDT
            USDC: 50_000_000_000n, // 500 USDC
          }
        : {
            ETH: 1_000_000n, // 0.01 ETH — relaxed for testnet
            USDT: 1_000_000_000n, // 10 USDT — relaxed for testnet
            USDC: 1_000_000_000n, // 10 USDC — relaxed for testnet
          },
      rebalanceThresholdPct: production ? 30 : 40,
    },

    trading: {
      combinedFeeRateBps: production ? 40n : 0n, // 0.1% CEX + 0.3% DEX in prod; testnet has no fees
    },
  };
}

export const BINANCE_PROFILE = getBinanceProfile(true);
