import { describe, expect, it } from 'vitest';
import {
  Address,
  Token,
  TokenAmount,
  TransactionReceipt,
  TransactionRequest,
} from '../core/baseTypes.js';

const ADDR_CHECKSUM = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const ADDR_LOWER = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';
const ADDR_OTHER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

describe('Address', () => {
  describe('constructor', () => {
    it('rejects invalid string with clear message', () => {
      expect(() => new Address('invalid')).toThrow('Invalid Ethereum address: invalid');
    });

    it('rejects empty string', () => {
      expect(() => new Address('')).toThrow();
    });

    it('rejects address without 0x prefix', () => {
      expect(() => new Address(ADDR_CHECKSUM.slice(2))).toThrow();
    });

    it('rejects address with wrong length', () => {
      expect(() => new Address('0x1234')).toThrow();
    });

    it('accepts checksummed address', () => {
      expect(new Address(ADDR_CHECKSUM).value).toBe(ADDR_CHECKSUM);
    });

    it('accepts lowercase address and normalizes to checksum', () => {
      expect(new Address(ADDR_LOWER).value).toBe(ADDR_CHECKSUM);
    });
  });

  describe('equality', () => {
    it('checksummed and lowercase versions of the same address are equal', () => {
      expect(new Address(ADDR_CHECKSUM).equals(new Address(ADDR_LOWER))).toBe(true);
    });

    it('different addresses are not equal', () => {
      expect(new Address(ADDR_CHECKSUM).equals(new Address(ADDR_OTHER))).toBe(false);
    });
  });

  describe('getters', () => {
    it('checksum returns EIP-55 checksummed form', () => {
      expect(new Address(ADDR_LOWER).checksum).toBe(ADDR_CHECKSUM);
    });

    it('lower returns lowercase form', () => {
      expect(new Address(ADDR_CHECKSUM).lower).toBe(ADDR_LOWER);
    });
  });

  it('fromString constructs correctly', () => {
    expect(Address.fromString(ADDR_CHECKSUM).value).toBe(ADDR_CHECKSUM);
  });

  it('toString returns checksummed address', () => {
    expect(new Address(ADDR_LOWER).toString()).toBe(ADDR_CHECKSUM);
  });
});


describe('TokenAmount', () => {
  describe('constructor', () => {
    it('stores raw bigint, decimals, and symbol', () => {
      const ta = new TokenAmount(1000n, 6, 'USDC');
      expect(ta.raw).toBe(1000n);
      expect(ta.decimals).toBe(6);
      expect(ta.symbol).toBe('USDC');
    });

    it('symbol defaults to null', () => {
      expect(new TokenAmount(1000n, 6).symbol).toBeNull();
    });
  });

  describe('fromHuman', () => {
    it('1.5 with 18 decimals produces 1500000000000000000n', () => {
      expect(TokenAmount.fromHuman('1.5', 18).raw).toBe(1500000000000000000n);
    });

    it('integer string with no decimal point', () => {
      expect(TokenAmount.fromHuman('100', 6).raw).toBe(100000000n);
    });

    it('zero', () => {
      expect(TokenAmount.fromHuman('0', 18).raw).toBe(0n);
    });

    it('fractional digits equal to decimals', () => {
      expect(TokenAmount.fromHuman('1.000001', 6).raw).toBe(1000001n);
    });

    it('fractional with trailing zeros', () => {
      expect(TokenAmount.fromHuman('1.500', 6).raw).toBe(1500000n);
    });

    it('raw value is a bigint (no float arithmetic internally)', () => {
      expect(typeof TokenAmount.fromHuman('1.5', 18).raw).toBe('bigint');
    });

    it('rejects more decimal places than token decimals', () => {
      expect(() => TokenAmount.fromHuman('1.1234567', 6)).toThrow(RangeError);
      expect(() => TokenAmount.fromHuman('1.1234567', 6)).toThrow('more decimal places');
    });

    it('rejects malformed amount with multiple dots', () => {
      expect(() => TokenAmount.fromHuman('1.2.3', 18)).toThrow('Invalid amount format');
    });
  });

  describe('human getter', () => {
    it('returns integer part (truncates fractional)', () => {
      expect(new TokenAmount(1500000000000000000n, 18).human).toBe('1');
    });

    it('returns 0 for zero amount', () => {
      expect(new TokenAmount(0n, 18).human).toBe('0');
    });
  });

  describe('add', () => {
    it('adds two amounts with the same decimals', () => {
      expect(new TokenAmount(1000n, 6).add(new TokenAmount(2000n, 6)).raw).toBe(3000n);
    });

    it('preserves decimals and symbol from left operand', () => {
      const result = new TokenAmount(1000n, 6, 'USDC').add(new TokenAmount(2000n, 6, 'USDC'));
      expect(result.decimals).toBe(6);
      expect(result.symbol).toBe('USDC');
    });

    it('rejects adding amounts with different decimals', () => {
      expect(() => new TokenAmount(1000n, 6).add(new TokenAmount(1000n, 18))).toThrow(
        'Cannot add TokenAmounts with different decimals: 6 vs 18',
      );
    });
  });

  describe('mul', () => {
    it('multiplies by bigint factor', () => {
      expect(new TokenAmount(1000n, 6).mul(3n).raw).toBe(3000n);
    });

    it('multiplies by number factor', () => {
      expect(new TokenAmount(1000n, 6).mul(3).raw).toBe(3000n);
    });
  });

  it('toString formats human amount with symbol', () => {
    expect(new TokenAmount(1000000n, 6, 'USDC').toString()).toBe('1 USDC');
  });
});


describe('Token', () => {
  const addr1 = new Address(ADDR_CHECKSUM);
  const addr2 = new Address(ADDR_OTHER);

  it('equals returns true for same address with different symbol', () => {
    expect(new Token(addr1, 'ETH', 18).equals(new Token(addr1, 'WETH', 18))).toBe(true);
  });

  it('equals returns false for different addresses', () => {
    expect(new Token(addr1, 'ETH', 18).equals(new Token(addr2, 'ETH', 18))).toBe(false);
  });

  it('equal tokens produce the same hash', () => {
    expect(new Token(addr1, 'ETH', 18).hash()).toBe(new Token(addr1, 'WETH', 18).hash());
  });

  it('different addresses produce different hashes', () => {
    expect(new Token(addr1, 'ETH', 18).hash()).not.toBe(new Token(addr2, 'ETH', 18).hash());
  });

  it('hash is a valid 32-byte keccak256 hex string', () => {
    expect(new Token(addr1, 'ETH', 18).hash()).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('checksum and lowercase address produce the same hash', () => {
    const t1 = new Token(new Address(ADDR_CHECKSUM), 'ETH', 18);
    const t2 = new Token(new Address(ADDR_LOWER), 'ETH', 18);
    expect(t1.hash()).toBe(t2.hash());
  });

  it('toString returns symbol and checksummed address', () => {
    expect(new Token(addr1, 'ETH', 18).toString()).toBe(`ETH (${ADDR_CHECKSUM})`);
  });
});


describe('TransactionRequest', () => {
  const addr = new Address(ADDR_CHECKSUM);
  const value = new TokenAmount(1000000000000000000n, 18, 'ETH');
  const data = new Uint8Array([0x01, 0x02]);

  it('stores all fields', () => {
    const tx = new TransactionRequest(addr, value, data, 1, 21000n, 100n, 2n, 1);
    expect(tx.to).toBe(addr);
    expect(tx.nonce).toBe(1);
    expect(tx.gasLimit).toBe(21000n);
    expect(tx.chainId).toBe(1);
  });

  it('optional fields default to null', () => {
    const tx = new TransactionRequest(addr, value, data);
    expect(tx.nonce).toBeNull();
    expect(tx.gasLimit).toBeNull();
    expect(tx.maxFeePerGas).toBeNull();
    expect(tx.maxPriorityFee).toBeNull();
  });

  it('chainId defaults to 1', () => {
    expect(new TransactionRequest(addr, value, data).chainId).toBe(1);
  });

  it('toDict returns plain object with checksummed address string', () => {
    const dict = new TransactionRequest(addr, value, data, 0, 21000n, 100n, 2n, 1).toDict();
    expect(dict['to']).toBe(ADDR_CHECKSUM);
    expect(dict['chainId']).toBe(1);
    expect(dict['nonce']).toBe(0);
  });
});


describe('TransactionReceipt', () => {
  const GAS_USED = 21000n;
  const GAS_PRICE = 50000000000n;

  const makeReceipt = () =>
    new TransactionReceipt('0xabc123', 18000000, true, GAS_USED, GAS_PRICE, []);

  it('stores all fields', () => {
    const r = makeReceipt();
    expect(r.txHash).toBe('0xabc123');
    expect(r.blockNumber).toBe(18000000);
    expect(r.status).toBe(true);
    expect(r.gasUsed).toBe(GAS_USED);
    expect(r.effectiveGasPrice).toBe(GAS_PRICE);
  });

  it('txFee computes gasUsed * effectiveGasPrice as 18-decimal TokenAmount', () => {
    const r = makeReceipt();
    expect(r.txFee.raw).toBe(GAS_USED * GAS_PRICE);
    expect(r.txFee.decimals).toBe(18);
  });

  it('fromWeb3 maps receipt fields correctly', () => {
    const r = TransactionReceipt.fromWeb3({
      transactionHash: '0xdef456',
      blockNumber: 1,
      status: false,
      gasUsed: 50000n,
      effectiveGasPrice: 1n,
      logs: [],
    });
    expect(r.txHash).toBe('0xdef456');
    expect(r.status).toBe(false);
    expect(r.gasUsed).toBe(50000n);
    expect(r.logs).toEqual([]);
  });
});
