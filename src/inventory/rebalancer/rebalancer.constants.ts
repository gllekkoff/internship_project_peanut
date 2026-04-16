import type { TransferFeeInfo } from './rebalancer.interfaces';

// PRICE_SCALE = 1e8; multiply human-readable amounts by 1e8 to get scaled bigint.

/** Hardcoded fee and timing parameters per asset — for testnet estimation only. */
export const TRANSFER_FEES: Record<string, TransferFeeInfo> = {
  ETH: {
    withdrawalFee: 500_000n, // 0.005 ETH
    minWithdrawal: 1_000_000n, // 0.01 ETH
    confirmations: 12,
    estimatedTimeMin: 15,
  },
  USDT: {
    withdrawalFee: 100_000_000n, // 1.0 USDT
    minWithdrawal: 1_000_000_000n, // 10.0 USDT
    confirmations: 12,
    estimatedTimeMin: 15,
  },
  USDC: {
    withdrawalFee: 100_000_000n, // 1.0 USDC
    minWithdrawal: 1_000_000_000n, // 10.0 USDC
    confirmations: 12,
    estimatedTimeMin: 15,
  },
};

/**
 * Minimum balance that must remain at each venue after a transfer to keep trading operational.
 * Scaled by PRICE_SCALE (1e8).
 */
export const MIN_OPERATING_BALANCE: Record<string, bigint> = {
  ETH: 50_000_000n, // 0.5 ETH
  USDT: 50_000_000_000n, // 500 USDT
  USDC: 50_000_000_000n, // 500 USDC
};

/** Default rebalance threshold in percentage points. */
export const DEFAULT_THRESHOLD_PCT = 30;
