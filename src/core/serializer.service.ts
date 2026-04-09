import { keccak256 } from 'viem';

export class CanonicalSerializer {
  /**
   * Produces deterministic JSON for signing.
   *
   * Rules:
   * - Keys sorted alphabetically (recursive)
   * - No whitespace
   * - Numbers as-is (but prefer string amounts in trading data)
   * - Consistent unicode handling
   */

  static serialize(obj: Record<string, unknown>): Uint8Array {
    const json = JSON.stringify(obj, (_, value) => {
      if (typeof value === 'number') {
        if (!Number.isInteger(value)) {
          throw new TypeError(
            `Floating point values are not allowed: ${value}. Use string amounts instead.`,
          );
        }
        if (!Number.isSafeInteger(value)) {
          throw new RangeError(
            `Integer exceeds safe range (> 2^53). Use a string or BigInt representation instead.`,
          );
        }
        return value;
      }

      if (typeof value === 'string') {
        return value.normalize('NFC');
      }

      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return Object.keys(value)
          .sort()
          .reduce(
            (sorted, key) => {
              sorted[key] = value[key];
              return sorted;
            },
            {} as Record<string, unknown>,
          );
      }

      return value;
    });

    return new TextEncoder().encode(json);
  }

  static hash(obj: Record<string, unknown>): `0x${string}` {
    return keccak256(CanonicalSerializer.serialize(obj));
  }

  static verify_determinism(obj: Record<string, unknown>, iterations: number = 100): boolean {
    const first = CanonicalSerializer.serialize(obj);
    for (let i = 0; i < iterations; i++) {
      const current = CanonicalSerializer.serialize(obj);
      if (!first.every((byte, index) => byte === current[index])) {
        return false;
      }
    }
    return true;
  }
}
