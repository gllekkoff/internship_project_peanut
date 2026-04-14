/** A single decoded log entry from a simulated transaction. */
export interface SimulationLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

/** Full outcome of a simulated swap or route — success/failure, amounts, gas, and decoded logs. */
export interface SimulationResult {
  readonly success: boolean;
  readonly amountOut: bigint;
  readonly gasUsed: bigint;
  /** Revert reason or RPC error message; null on success. */
  readonly error: string | null;
  /** Raw logs emitted during simulation (e.g. Transfer, Swap events). */
  readonly logs: SimulationLog[];
}

/** Output of compareSimulationVsCalculation — shows whether local AMM math matches the fork. */
export interface ComparisonResult {
  readonly calculated: bigint;
  readonly simulated: bigint;
  readonly difference: bigint;
  readonly match: boolean;
}
