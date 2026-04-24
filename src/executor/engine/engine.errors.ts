import { AppError } from '@/core/core.errors';

/** Signal was rejected before execution — expired, invalid, or duplicate. */
export class SignalRejectedError extends AppError {}

/** Circuit breaker is open — too many consecutive failures within the window. */
export class CircuitOpenError extends AppError {}

/** Execution leg failed to fill within the timeout or was rejected by the venue. */
export class LegExecutionError extends AppError {}

/** Unwind trade failed after a partial fill — position may be stuck. */
export class UnwindError extends AppError {}
