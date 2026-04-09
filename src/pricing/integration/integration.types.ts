import type { Route } from '@/pricing/routing/routing.service';

export class Quote {
  constructor(
    public route: Route,
    public amountIn: bigint,
    public expectedOutput: bigint,
    public simulatedOutput: bigint,
    public gasEstimate: bigint,
    public timestamp: number,
  ) {}

  get isValid(): boolean {
    const diff =
      this.expectedOutput > this.simulatedOutput
        ? this.expectedOutput - this.simulatedOutput
        : this.simulatedOutput - this.expectedOutput;

    return diff * 1000n < this.expectedOutput;
  }
}
