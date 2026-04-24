import { PRICE_SCALE } from '@/core/core.constants';

/** Fee parameters for one arb pair — bps values are basis points, gasCost is scaled by PRICE_SCALE. */
export interface FeeStructureParams {
  readonly cexTakerBps?: number;
  readonly dexSwapBps?: number;
  /** Gas cost in quote currency, scaled by PRICE_SCALE. Default: 5 USD. */
  readonly gasCost?: bigint;
}

/** Computes fee breakdowns and net profit for a given trade size. Pure math, no side effects. */
export class FeeCalculator {
  readonly cexTakerBps: number;
  readonly dexSwapBps: number;
  readonly gasCost: bigint;

  constructor(params: FeeStructureParams = {}) {
    this.cexTakerBps = params.cexTakerBps ?? 10;
    this.dexSwapBps = params.dexSwapBps ?? 30;
    this.gasCost = params.gasCost ?? 5n * PRICE_SCALE;
  }

  /**
   * Total fee in scaled units: rate-based CEX + DEX fees plus gas cost.
   * When liveGasCost is provided it overrides the static gasCost from construction.
   */
  totalFee(tradeValue: bigint, liveGasCost?: bigint | null): bigint {
    const rateFeeBps = BigInt(this.cexTakerBps + this.dexSwapBps);
    const gas = liveGasCost ?? this.gasCost;
    return (tradeValue * rateFeeBps) / 10_000n + gas;
  }

  /** Total cost in bps: rate fees plus gas converted to bps at this trade size. */
  totalFeeBps(tradeValue: bigint): number {
    if (tradeValue === 0n) return 0;
    // Float division: bigint integer division would truncate sub-integer bps.
    return (Number(this.totalFee(tradeValue)) / Number(tradeValue)) * 10_000;
  }

  /** Minimum spread in bps required to break even at this trade value. */
  breakevenSpreadBps(tradeValue: bigint): number {
    return this.totalFeeBps(tradeValue);
  }

  /** Net profit in scaled units after all fees for a given spread and trade value. */
  netProfit(spreadBps: number, tradeValue: bigint): bigint {
    const gross = (BigInt(spreadBps) * tradeValue) / 10_000n;
    return gross - this.totalFee(tradeValue);
  }
}
