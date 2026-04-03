import { describe, expect, it } from 'vitest';
import {
  ChainError,
  InsufficientFunds,
  NonceTooLow,
  RPCError,
  ReplacementUnderpriced,
  TransactionFailed,
  isRetryable,
} from '../chain/errorHandling.js';
import { TransactionReceipt } from '../core/baseTypes.js';

const makeReceipt = () =>
  new TransactionReceipt('0xabc', 1, false, 21000n, 1000000000n, []);

describe('Error hierarchy', () => {
  it('ChainError is an instance of Error', () => {
    expect(new ChainError('oops')).toBeInstanceOf(Error);
  });

  it('ChainError.name is the class name', () => {
    expect(new ChainError('oops').name).toBe('ChainError');
  });

  it('RPCError stores code', () => {
    const e = new RPCError('bad request', -32600);
    expect(e.code).toBe(-32600);
    expect(e.name).toBe('RPCError');
  });

  it('RPCError code defaults to null', () => {
    expect(new RPCError('bad request').code).toBeNull();
  });

  it('TransactionFailed stores txHash and receipt', () => {
    const receipt = makeReceipt();
    const e = new TransactionFailed('0xabc', receipt);
    expect(e.txHash).toBe('0xabc');
    expect(e.receipt).toBe(receipt);
    expect(e.name).toBe('TransactionFailed');
    expect(e.message).toContain('0xabc');
  });

  it('InsufficientFunds is a ChainError', () => {
    expect(new InsufficientFunds('broke')).toBeInstanceOf(ChainError);
    expect(new InsufficientFunds('broke').name).toBe('InsufficientFunds');
  });

  it('NonceTooLow is a ChainError', () => {
    expect(new NonceTooLow('old nonce')).toBeInstanceOf(ChainError);
    expect(new NonceTooLow('old nonce').name).toBe('NonceTooLow');
  });

  it('ReplacementUnderpriced is a ChainError', () => {
    expect(new ReplacementUnderpriced('too cheap')).toBeInstanceOf(ChainError);
  });

  it('all subclasses are instanceof Error', () => {
    expect(new RPCError('x')).toBeInstanceOf(Error);
    expect(new TransactionFailed('0x', makeReceipt())).toBeInstanceOf(Error);
    expect(new InsufficientFunds('x')).toBeInstanceOf(Error);
    expect(new NonceTooLow('x')).toBeInstanceOf(Error);
    expect(new ReplacementUnderpriced('x')).toBeInstanceOf(Error);
  });
});

describe('isRetryable', () => {
  it('returns false for any ChainError subclass', () => {
    expect(isRetryable(new ChainError('x'))).toBe(false);
    expect(isRetryable(new RPCError('x'))).toBe(false);
    expect(isRetryable(new TransactionFailed('0x', makeReceipt()))).toBe(false);
    expect(isRetryable(new InsufficientFunds('x'))).toBe(false);
    expect(isRetryable(new NonceTooLow('x'))).toBe(false);
    expect(isRetryable(new ReplacementUnderpriced('x'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isRetryable('string error')).toBe(false);
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable(42)).toBe(false);
  });

  it('returns true for ECONNREFUSED', () => {
    expect(isRetryable(new Error('connect ECONNREFUSED 127.0.0.1:8545'))).toBe(true);
  });

  it('returns true for ETIMEDOUT', () => {
    expect(isRetryable(new Error('ETIMEDOUT'))).toBe(true);
  });

  it('returns true for ECONNRESET', () => {
    expect(isRetryable(new Error('read ECONNRESET'))).toBe(true);
  });

  it('returns true for fetch failed', () => {
    expect(isRetryable(new Error('fetch failed'))).toBe(true);
  });

  it('returns true for network error', () => {
    expect(isRetryable(new Error('network error occurred'))).toBe(true);
  });

  it('returns true for rate limit', () => {
    expect(isRetryable(new Error('rate limit exceeded'))).toBe(true);
  });

  it('returns true for 429 in message', () => {
    expect(isRetryable(new Error('HTTP 429 Too Many Requests'))).toBe(true);
  });

  it('returns true for 502/503/504', () => {
    expect(isRetryable(new Error('502 Bad Gateway'))).toBe(true);
    expect(isRetryable(new Error('503 Service Unavailable'))).toBe(true);
    expect(isRetryable(new Error('504 Gateway Timeout'))).toBe(true);
  });

  it('returns false for generic unrecognized errors', () => {
    expect(isRetryable(new Error('something went wrong'))).toBe(false);
    expect(isRetryable(new Error('invalid argument'))).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isRetryable(new Error('ECONNREFUSED'))).toBe(true);
    expect(isRetryable(new Error('Rate Limit Exceeded'))).toBe(true);
  });
});
