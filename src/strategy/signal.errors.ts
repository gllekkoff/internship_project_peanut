import { AppError } from '@/core/core.errors';

/** Signal could not be generated — prices unavailable, spread below threshold, or inventory insufficient. */
export class SignalGenerationError extends AppError {}

/** Gas price fetch failed — signal generator fell back to static gas cost. */
export class GasPriceFetchError extends AppError {}
