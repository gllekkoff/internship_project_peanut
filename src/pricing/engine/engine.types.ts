import type { Route } from '@/pricing/routing/routing.service';

/** Route + amounts + validity flag for a priced swap. */
export class Quote {
  constructor(
    public route: Route,
    public amountIn: bigint,
    public expectedOutput: bigint,
    public simulatedOutput: bigint,
    public gasEstimate: bigint,
    public timestamp: number,
  ) {}

  /** Returns true when the simulated output is within 0.1% of the expected output. */
  get isValid(): boolean {
    const diff =
      this.expectedOutput > this.simulatedOutput
        ? this.expectedOutput - this.simulatedOutput
        : this.simulatedOutput - this.expectedOutput;

    return diff * 1000n < this.expectedOutput;
  }
}
