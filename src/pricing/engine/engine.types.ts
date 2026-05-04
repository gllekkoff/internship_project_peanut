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
    /** Max allowed deviation between expected and simulated output in basis points (default 10 = 0.1%). */
    public readonly slippageToleranceBps: bigint = 10n,
  ) {}

  /** Returns true when the simulated output is within slippageToleranceBps of the expected output. */
  get isValid(): boolean {
    const diff =
      this.expectedOutput > this.simulatedOutput
        ? this.expectedOutput - this.simulatedOutput
        : this.simulatedOutput - this.expectedOutput;

    return diff * 10_000n < this.expectedOutput * this.slippageToleranceBps;
  }
}
