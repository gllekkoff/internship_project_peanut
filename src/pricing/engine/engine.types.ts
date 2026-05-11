import type { Route } from '@/pricing/routing/routing.service';

/** Route + amounts + validity flag for a priced swap. */
export class Quote {
  constructor(
    public readonly route: Route,
    public readonly amountIn: bigint,
    public readonly expectedOutput: bigint,
    public readonly simulatedOutput: bigint,
    public readonly gasEstimate: bigint,
    public readonly timestamp: number,
    /** Max allowed deviation between expected and simulated output in basis points. */
    public readonly slippageToleranceBps: bigint = 100n,
  ) {}

  /** Rejects if simulated output deviates beyond tolerance in the unfavourable direction (less output
   *  than expected), or beyond 5× tolerance in the favourable direction (guards against stale/bad data). */
  get isValid(): boolean {
    if (this.simulatedOutput < this.expectedOutput) {
      const diff = this.expectedOutput - this.simulatedOutput;
      return diff * 10_000n < this.expectedOutput * this.slippageToleranceBps;
    }
    // Simulated is higher than expected — favourable, but cap at 5× tolerance to catch bad fork data.
    const diff = this.simulatedOutput - this.expectedOutput;
    return diff * 10_000n < this.expectedOutput * (this.slippageToleranceBps * 5n);
  }
}
