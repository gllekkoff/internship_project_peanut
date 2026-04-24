import type { Signal } from '@/strategy/signal.interfaces';

/** Lifecycle state of a two-legged arb execution. */
export enum ExecutorState {
  IDLE = 'IDLE',
  VALIDATING = 'VALIDATING',
  LEG1_PENDING = 'LEG1_PENDING',
  LEG1_FILLED = 'LEG1_FILLED',
  LEG2_PENDING = 'LEG2_PENDING',
  DONE = 'DONE',
  FAILED = 'FAILED',
  UNWINDING = 'UNWINDING',
}

/** Mutable execution context threaded through each stage of the executor pipeline. */
export interface ExecutionContext {
  readonly signal: Signal;
  state: ExecutorState;

  leg1Venue: string;
  leg1OrderId: string | null;
  /** Fill price for leg 1, scaled by PRICE_SCALE. */
  leg1FillPrice: bigint | null;
  /** Fill size for leg 1, scaled by PRICE_SCALE. */
  leg1FillSize: bigint | null;

  leg2Venue: string;
  leg2TxHash: string | null;
  /** Fill price for leg 2, scaled by PRICE_SCALE. */
  leg2FillPrice: bigint | null;
  /** Fill size for leg 2, scaled by PRICE_SCALE. */
  leg2FillSize: bigint | null;

  readonly startedAt: Date;
  finishedAt: Date | null;
  /** Realised net PnL in quote currency after both legs complete, scaled by PRICE_SCALE. */
  actualNetPnlUsd: bigint | null;
  error: string | null;
}

/** Configuration knobs for the Executor. */
export interface ExecutorConfig {
  /** Milliseconds to wait for the CEX leg to fill (default 5s). */
  readonly leg1TimeoutMs?: number;
  /** Milliseconds to wait for the DEX leg to confirm (default 60s). */
  readonly leg2TimeoutMs?: number;
  /** Minimum fill ratio [0–1] below which a partial fill triggers failure (default 0.8). */
  readonly minFillRatio?: number;
  /** When true, execute DEX leg first via Flashbots — failed tx costs nothing (default true). */
  readonly useFlashbots?: boolean;
  /** When true, legs are simulated with artificial delays — no real orders are sent (default true). */
  readonly simulationMode?: boolean;
}

/** Normalised result returned from an individual leg execution. */
export interface LegResult {
  readonly success: boolean;
  /** Execution price, scaled by PRICE_SCALE. */
  readonly price: bigint;
  /** Amount filled, scaled by PRICE_SCALE. */
  readonly filled: bigint;
  readonly error?: string;
}
