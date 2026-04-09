import { describe, expect, it } from 'vitest';
import { greet } from '@/index';

describe('greet', () => {
  it('should return a greeting with the given name', () => {
    expect(greet('World')).toBe('Hello, World!');
  });

  it('handles empty string input', () => {
    expect(greet('')).toBe('Hello, !');
  });
});
