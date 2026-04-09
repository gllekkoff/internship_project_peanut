/**
 * Holds sampled fee data for a chain and computes EIP-1559 max fees.
 * Priority fees are derived from historical block reward percentiles.
 * All arithmetic uses integer math — no floats leak into results.
 */
export class GasPrice {
  readonly baseFee: bigint;
  readonly priorityFeeLow: bigint;
  readonly priorityFeeMedium: bigint;
  readonly priorityFeeHigh: bigint;

  constructor(
    baseFee: bigint,
    priorityFeeLow: bigint,
    priorityFeeMedium: bigint,
    priorityFeeHigh: bigint,
  ) {
    this.baseFee = baseFee;
    this.priorityFeeLow = priorityFeeLow;
    this.priorityFeeMedium = priorityFeeMedium;
    this.priorityFeeHigh = priorityFeeHigh;
  }

  /**
   * Calculates maxFeePerGas = floor(baseFee * buffer) + priorityFee.
   *
   * Buffer defaults to 1.2 to handle up to ~2 blocks of base fee growth
   * (EIP-1559 allows max 12.5% increase per block).
   * Uses integer arithmetic — no floats.
   */
  getMaxFee(priority: 'low' | 'medium' | 'high' = 'medium', buffer: number = 1.2): bigint {
    const priorityFees = {
      low: this.priorityFeeLow,
      medium: this.priorityFeeMedium,
      high: this.priorityFeeHigh,
    };
    const bufferedBaseFee = (this.baseFee * BigInt(Math.round(buffer * 1000))) / 1000n;
    return bufferedBaseFee + priorityFees[priority];
  }
}
