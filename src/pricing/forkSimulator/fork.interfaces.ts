/** Full outcome of a simulated swap or route — success/failure, amounts, and gas. */
export interface SimulationResult {
  readonly success: boolean;
  readonly amountOut: bigint;
  readonly gasUsed: bigint;
  /** Revert reason or RPC error message; null on success. */
  readonly error: string | null;
}

/** Output of compareSimulationVsCalculation — shows whether local AMM math matches the fork. */
export interface ComparisonResult {
  readonly calculated: bigint;
  readonly simulated: bigint;
  readonly difference: bigint;
  readonly match: boolean;
}
