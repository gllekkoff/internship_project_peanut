import { AppError } from '@/core/core.errors';

/** Thrown when check() is called for a pair that was not registered in the constructor. */
export class UnknownPairError extends AppError {}

/** Thrown when the DEX pool does not contain the expected base or quote token. */
export class PairConfigError extends AppError {}
