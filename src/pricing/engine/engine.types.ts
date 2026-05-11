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

  /** Rejects only when simulated output is below expected beyond tolerance.
   *  Simulated above expected is always valid — the trade executes on the live chain anyway. */
  get isValid(): boolean {
    if (this.simulatedOutput >= this.expectedOutput) return true;
    const diff = this.expectedOutput - this.simulatedOutput;
    return diff * 10_000n < this.expectedOutput * this.slippageToleranceBps;
  }
}
