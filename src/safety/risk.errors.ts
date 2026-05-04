import { AppError } from '@/core/core.errors';

/** Raised when a trade is blocked by a hard risk limit. */
export class RiskLimitError extends AppError {}

/** Actual balance diverges from InventoryTracker expectation — possible accounting bug or external interference. */
export class BalanceMismatchError extends AppError {}
