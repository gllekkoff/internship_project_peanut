import { describe, expect, it } from 'vitest';
import { CanonicalSerializer } from '../core/canonicalSerializer.js';

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);


describe('CanonicalSerializer - key ordering', () => {
  it('sorts top-level keys alphabetically', () => {
    expect(decode(CanonicalSerializer.serialize({ z: 1, a: 1, m: 1 }))).toBe('{"a":1,"m":1,"z":1}');
  });

  it('sorts nested object keys recursively', () => {
    expect(decode(CanonicalSerializer.serialize({ outer: { z: 1, a: 1 } }))).toBe(
      '{"outer":{"a":1,"z":1}}',
    );
  });

  it('mixed key order produces same bytes as pre-sorted input', () => {
    const a = CanonicalSerializer.serialize({ b: 2, a: 1, c: { z: 9, m: 5 } });
    const b = CanonicalSerializer.serialize({ a: 1, b: 2, c: { m: 5, z: 9 } });
    expect(a).toEqual(b);
  });

  it('sorts keys at every depth', () => {
    expect(decode(CanonicalSerializer.serialize({ a: { z: { y: 1, x: 2 }, a: 0 } }))).toBe(
      '{"a":{"a":0,"z":{"x":2,"y":1}}}',
    );
  });

  it('objects inside arrays have sorted keys', () => {
    expect(decode(CanonicalSerializer.serialize({ items: [{ z: 1, a: 2 }] }))).toBe(
      '{"items":[{"a":2,"z":1}]}',
    );
  });
});


describe('CanonicalSerializer - unicode', () => {
  it('handles emoji', () => {
    expect(() => CanonicalSerializer.serialize({ msg: '🚀' })).not.toThrow();
  });

  it('handles non-ASCII characters (Japanese)', () => {
    expect(() => CanonicalSerializer.serialize({ msg: 'こんにちは' })).not.toThrow();
  });

  it('handles Arabic text', () => {
    expect(() => CanonicalSerializer.serialize({ msg: 'مرحبا' })).not.toThrow();
  });

  it('NFC and NFD representations of the same string produce identical bytes', () => {
    const nfc = 'caf\u00e9'; // é as single codepoint (NFC)
    const nfd = 'cafe\u0301'; // é as e + combining accent (NFD)
    expect(nfc).not.toBe(nfd); // confirm they are different JS strings
    expect(CanonicalSerializer.serialize({ v: nfc })).toEqual(
      CanonicalSerializer.serialize({ v: nfd }),
    );
  });

  it('mixed NFC/NFD in nested objects normalize consistently', () => {
    const a = CanonicalSerializer.serialize({ k: { v: 'caf\u00e9' } });
    const b = CanonicalSerializer.serialize({ k: { v: 'cafe\u0301' } });
    expect(a).toEqual(b);
  });
});


describe('CanonicalSerializer - numbers', () => {
  it('allows zero', () => {
    expect(() => CanonicalSerializer.serialize({ n: 0 })).not.toThrow();
  });

  it('allows safe positive integers', () => {
    expect(() => CanonicalSerializer.serialize({ n: Number.MAX_SAFE_INTEGER })).not.toThrow();
  });

  it('allows safe negative integers', () => {
    expect(() => CanonicalSerializer.serialize({ n: -100 })).not.toThrow();
  });

  it('rejects integers above MAX_SAFE_INTEGER with RangeError', () => {
    expect(() => CanonicalSerializer.serialize({ n: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      RangeError,
    );
  });

  it('rejects positive float with TypeError', () => {
    expect(() => CanonicalSerializer.serialize({ n: 1.5 })).toThrow(TypeError);
    expect(() => CanonicalSerializer.serialize({ n: 1.5 })).toThrow('Floating point');
  });

  it('rejects negative float with TypeError', () => {
    expect(() => CanonicalSerializer.serialize({ n: -1.5 })).toThrow(TypeError);
  });

  it('rejects NaN with TypeError', () => {
    expect(() => CanonicalSerializer.serialize({ n: NaN })).toThrow(TypeError);
  });

  it('rejects Infinity with TypeError', () => {
    expect(() => CanonicalSerializer.serialize({ n: Infinity })).toThrow(TypeError);
  });

  it('rejects float nested inside object', () => {
    expect(() => CanonicalSerializer.serialize({ a: { b: 1.1 } })).toThrow(TypeError);
  });

  it('rejects float inside array', () => {
    expect(() => CanonicalSerializer.serialize({ arr: [1.5] })).toThrow(TypeError);
  });
});


describe('CanonicalSerializer - null values', () => {
  it('serializes null value as JSON null', () => {
    expect(decode(CanonicalSerializer.serialize({ a: null }))).toBe('{"a":null}');
  });

  it('handles object with mixed null and non-null values', () => {
    expect(decode(CanonicalSerializer.serialize({ b: null, a: 1 }))).toBe('{"a":1,"b":null}');
  });

  it('handles nested null', () => {
    expect(decode(CanonicalSerializer.serialize({ a: { b: null } }))).toBe('{"a":{"b":null}}');
  });
});


describe('CanonicalSerializer - empty structures', () => {
  it('serializes empty object', () => {
    expect(decode(CanonicalSerializer.serialize({}))).toBe('{}');
  });

  it('serializes empty array value', () => {
    expect(decode(CanonicalSerializer.serialize({ arr: [] }))).toBe('{"arr":[]}');
  });

  it('serializes nested empty object', () => {
    expect(decode(CanonicalSerializer.serialize({ a: {} }))).toBe('{"a":{}}');
  });
});


describe('CanonicalSerializer.hash', () => {
  it('returns a 0x-prefixed 32-byte hex string', () => {
    expect(CanonicalSerializer.hash({ a: 1 })).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('same object produces same hash', () => {
    expect(CanonicalSerializer.hash({ a: 1, b: 2 })).toBe(CanonicalSerializer.hash({ a: 1, b: 2 }));
  });

  it('different objects produce different hashes', () => {
    expect(CanonicalSerializer.hash({ a: 1 })).not.toBe(CanonicalSerializer.hash({ a: 2 }));
  });

  it('key order does not affect hash', () => {
    expect(CanonicalSerializer.hash({ b: 2, a: 1 })).toBe(CanonicalSerializer.hash({ a: 1, b: 2 }));
  });

  it('NFC/NFD unicode produces same hash', () => {
    expect(CanonicalSerializer.hash({ v: 'caf\u00e9' })).toBe(
      CanonicalSerializer.hash({ v: 'cafe\u0301' }),
    );
  });
});


describe('CanonicalSerializer.verify_determinism', () => {
  it('returns true for a simple object', () => {
    expect(CanonicalSerializer.verify_determinism({ a: 1, b: 'hello', c: null })).toBe(true);
  });

  it('returns true for nested objects', () => {
    expect(CanonicalSerializer.verify_determinism({ z: { y: 1, x: 2 }, a: [1, 2] })).toBe(true);
  });

  it('accepts custom iteration count', () => {
    expect(CanonicalSerializer.verify_determinism({ a: 1 }, 5)).toBe(true);
  });

  it('returns true for empty object', () => {
    expect(CanonicalSerializer.verify_determinism({})).toBe(true);
  });

  it('returns true for unicode content', () => {
    expect(CanonicalSerializer.verify_determinism({ msg: '🚀 café' })).toBe(true);
  });
});
