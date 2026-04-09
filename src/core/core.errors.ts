/** Strips 32-byte hex values (private keys, secrets) from a string before it reaches any error message or log. */
function sanitizeMessage(msg: string): string {
  return msg.replace(/0x[0-9a-fA-F]{64}/g, '0x[REDACTED]');
}

/**
 * Base class for all domain errors in this project.
 * Sanitizes the message at construction so keys can never leak through error.message,
 * and forwards `cause` so the original stack trace is preserved for debugging.
 * All domain .errors.ts files must extend this class.
 */
export class AppError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(sanitizeMessage(message), options);
    this.name = this.constructor.name;
  }
}

/** Key loading, env var validation, or account setup failed. */
export class WalletError extends AppError {}

/** Cryptographic signing failed — message, typed data, or transaction. */
export class SigningError extends AppError {}

/** Keyfile read, write, or decryption failed. Never includes the password or decrypted key in the message. */
export class KeyfileError extends AppError {}
