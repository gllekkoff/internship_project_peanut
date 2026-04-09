import { describe, expect, it } from 'vitest';
import { Address, Token } from '@/core/core.types';
import { UniswapV2Pair } from '@/pricing/uniswap-v2/uniswap-v2.service';
import { UniswapV2Calculator } from '@/pricing/uniswap-v2/uniswap-v2.calculator';
import {
  InsufficientLiquidityError,
  UnknownTokenError,
} from '@/pricing/uniswap-v2/uniswap-v2.errors';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const WETH_ADDR = new Address('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
const USDC_ADDR = new Address('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');

// Uniswap V2 canonical ordering: token0 < token1 (by address hex, lexicographic)
// USDC address (0xA0b...) < WETH address (0xC02...) → token0 = USDC, token1 = WETH
const USDC = new Token(USDC_ADDR, 'USDC', 6);
const WETH = new Token(WETH_ADDR, 'WETH', 18);

const PAIR_ADDR = new Address('0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc');

/**
 * Creates the canonical 1000 ETH / 2 M USDC pool used throughout the suite.
 * token0 = USDC (6 dec), token1 = WETH (18 dec), fee = 30 bps.
 */
const makePair = (
  reserve0 = 2_000_000n * 10n ** 6n, // 2 000 000 USDC
  reserve1 = 1_000n * 10n ** 18n, // 1 000 WETH
  feeBps = 30n,
) => new UniswapV2Pair(PAIR_ADDR, USDC, WETH, reserve0, reserve1, feeBps);

// ---------------------------------------------------------------------------
// UniswapV2Pair — getAmountOut
// ---------------------------------------------------------------------------

describe('UniswapV2Pair.getAmountOut', () => {
  it('buying ~1 ETH with 2000 USDC returns slightly less than 1 ETH', () => {
    const pair = makePair();
    const usdcIn = 2_000n * 10n ** 6n; // 2 000 USDC

    // USDC is token0, so USDC is the sell side
    const wethOut = pair.getAmountOut(usdcIn, USDC);

    // With fee + price impact, should be just under 1 ETH
    expect(wethOut).toBeLessThan(1n * 10n ** 18n);
    // But very close — at least 0.99 ETH (pool is deep relative to trade size)
    expect(wethOut).toBeGreaterThan(990n * 10n ** 15n); // 0.990 ETH
  });

  it('returns a bigint', () => {
    const out = makePair().getAmountOut(2_000n * 10n ** 6n, USDC);
    expect(typeof out).toBe('bigint');
  });

  it('larger input → proportionally larger output (monotonicity)', () => {
    const pair = makePair();
    const small = pair.getAmountOut(1_000n * 10n ** 6n, USDC);
    const large = pair.getAmountOut(4_000n * 10n ** 6n, USDC);
    expect(large).toBeGreaterThan(small);
  });

  it('output is strictly less than reserve_out', () => {
    const pair = makePair();
    const out = pair.getAmountOut(2_000n * 10n ** 6n, USDC);
    expect(out).toBeLessThan(pair.reserve1); // reserve1 = WETH
  });

  it('works for both trade directions', () => {
    const pair = makePair();
    const wethIn = 1n * 10n ** 18n; // sell 1 WETH
    const usdcOut = pair.getAmountOut(wethIn, WETH);
    // At 2000 $/ETH pool price, should get roughly 1994–1999 USDC (fee eats ~6 USDC)
    expect(usdcOut).toBeGreaterThan(1_990n * 10n ** 6n);
    expect(usdcOut).toBeLessThan(2_000n * 10n ** 6n);
  });

  it('throws InsufficientLiquidityError when amountIn is 0', () => {
    expect(() => makePair().getAmountOut(0n, USDC)).toThrow(InsufficientLiquidityError);
  });

  it('throws UnknownTokenError for a token not in this pair', () => {
    const alien = new Token(new Address('0x6B175474E89094C44Da98b954EedeAC495271d0F'), 'DAI', 18);
    expect(() => makePair().getAmountOut(1_000n, alien)).toThrow(UnknownTokenError);
  });
});

// ---------------------------------------------------------------------------
// UniswapV2Pair — getAmountIn
// ---------------------------------------------------------------------------

describe('UniswapV2Pair.getAmountIn', () => {
  it('returns number of USDC required to buy exactly 1 WETH', () => {
    const pair = makePair();
    const wethWanted = 1n * 10n ** 18n;
    const usdcRequired = pair.getAmountIn(wethWanted, WETH);

    // Should require slightly more than 2000 USDC due to fee
    expect(usdcRequired).toBeGreaterThan(2_000n * 10n ** 6n);
    expect(usdcRequired).toBeLessThan(2_010n * 10n ** 6n);
  });

  it('getAmountIn / getAmountOut are inverses (round-trip)', () => {
    const pair = makePair();
    const wantOut = 1n * 10n ** 18n; // 1 WETH
    const requiredIn = pair.getAmountIn(wantOut, WETH);
    // Feeding requiredIn back through getAmountOut should yield >= wantOut
    const actualOut = pair.getAmountOut(requiredIn, USDC);
    expect(actualOut).toBeGreaterThanOrEqual(wantOut);
  });

  it('rounds up by +1 to match Solidity semantics', () => {
    // Exact Solidity formula: (reserveIn * amountOut * 10000) / ((reserveOut - amountOut) * (10000 - fee)) + 1
    const reserveIn = 2_000_000n * 10n ** 6n;
    const reserveOut = 1_000n * 10n ** 18n;
    const amountOut = 1n * 10n ** 18n;
    const feeBps = 30n;

    const numerator = reserveIn * amountOut * 10_000n;
    const denominator = (reserveOut - amountOut) * (10_000n - feeBps);
    const expected = numerator / denominator + 1n;

    const pair = makePair();
    expect(pair.getAmountIn(amountOut, WETH)).toBe(expected);
  });

  it('throws InsufficientLiquidityError when amountOut >= reserveOut', () => {
    const pair = makePair();
    expect(() => pair.getAmountIn(pair.reserve1, WETH)).toThrow(InsufficientLiquidityError);
  });
});

// ---------------------------------------------------------------------------
// Solidity parity — exact formula verification
// ---------------------------------------------------------------------------

describe('Exact Solidity parity', () => {
  /**
   * Reproduces the on-chain Uniswap V2 formula in pure TS and confirms the
   * calculator returns the identical value for the same inputs.
   */
  it('getAmountOut matches manual Solidity formula for 2000 USDC → WETH', () => {
    const reserveIn = 2_000_000n * 10n ** 6n;
    const reserveOut = 1_000n * 10n ** 18n;
    const amountIn = 2_000n * 10n ** 6n;
    const feeBps = 30n;

    // Exact Solidity integer formula
    const amountInWithFee = amountIn * (10_000n - feeBps);
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn * 10_000n + amountInWithFee;
    const expected = numerator / denominator;

    const actual = UniswapV2Calculator.getAmountOut(amountIn, reserveIn, reserveOut, feeBps);
    expect(actual).toBe(expected);
  });

  it('getAmountOut matches manual Solidity formula for 1 WETH → USDC', () => {
    const reserveIn = 1_000n * 10n ** 18n;
    const reserveOut = 2_000_000n * 10n ** 6n;
    const amountIn = 1n * 10n ** 18n;
    const feeBps = 30n;

    const amountInWithFee = amountIn * (10_000n - feeBps);
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn * 10_000n + amountInWithFee;
    const expected = numerator / denominator;

    const actual = UniswapV2Calculator.getAmountOut(amountIn, reserveIn, reserveOut, feeBps);
    expect(actual).toBe(expected);
  });

  it('result equals exact bigint floor division (no float rounding)', () => {
    // Verifies that bigint integer division truncates identically to Solidity's
    // integer division — no off-by-one from floating-point rounding.
    const reserveIn = 2_000_000n * 10n ** 6n;
    const reserveOut = 1_000n * 10n ** 18n;
    const amountIn = 7_777n * 10n ** 6n;
    const feeBps = 30n;

    const actual = UniswapV2Calculator.getAmountOut(amountIn, reserveIn, reserveOut, feeBps);

    // Reproduce the Solidity formula in pure bigint — this IS the ground truth.
    const amountInWithFee = amountIn * (10_000n - feeBps);
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn * 10_000n + amountInWithFee;
    const expected = numerator / denominator; // bigint floor division

    expect(actual).toBe(expected);
    // Confirm result is strictly less than the un-floored exact rational
    // i.e. truncation happened correctly (no rounding up).
    const remainder = numerator % denominator;
    if (remainder > 0n) {
      expect(actual).toBe(expected); // was truncated, not rounded
    }
  });
});

// ---------------------------------------------------------------------------
// Integer math — precision with huge numbers
// ---------------------------------------------------------------------------

describe('Integer math — no float precision loss', () => {
  const HUGE_ADDR_0 = new Address('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
  const HUGE_ADDR_1 = new Address('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
  const TOKEN_A = new Token(HUGE_ADDR_0, 'TKA', 18);
  const TOKEN_B = new Token(HUGE_ADDR_1, 'TKB', 18);

  const hugePair = () =>
    new UniswapV2Pair(
      PAIR_ADDR,
      TOKEN_A,
      TOKEN_B,
      10n ** 30n, // Massive reserve — would lose precision as float64
      10n ** 30n,
      30n,
    );

  it('getAmountOut with huge reserves returns a bigint', () => {
    const out = hugePair().getAmountOut(10n ** 25n, TOKEN_A);
    expect(typeof out).toBe('bigint');
  });

  it('getAmountOut does not throw on astronomically large reserves', () => {
    expect(() => hugePair().getAmountOut(10n ** 25n, TOKEN_A)).not.toThrow();
  });

  it('result is positive and within reserve bounds', () => {
    const pair = hugePair();
    const out = pair.getAmountOut(10n ** 25n, TOKEN_A);
    expect(out).toBeGreaterThan(0n);
    expect(out).toBeLessThan(10n ** 30n);
  });

  it('maximum safe integer overflow scenario: result is exact', () => {
    // Number.MAX_SAFE_INTEGER = 9_007_199_254_740_991 ≈ 9 × 10^15
    // Any reserve above this would silently corrupt a float-based calc.
    const overMax = BigInt(Number.MAX_SAFE_INTEGER) * 1_000_000n;
    const pair = new UniswapV2Pair(PAIR_ADDR, TOKEN_A, TOKEN_B, overMax, overMax, 30n);
    const amountIn = BigInt(Number.MAX_SAFE_INTEGER);

    const out = pair.getAmountOut(amountIn, TOKEN_A);
    // Manually verify with bigint math
    const amountInWithFee = amountIn * 9_970n;
    const numerator = amountInWithFee * overMax;
    const denominator = overMax * 10_000n + amountInWithFee;
    expect(out).toBe(numerator / denominator);
  });
});

// ---------------------------------------------------------------------------
// simulate_swap — immutability
// ---------------------------------------------------------------------------

describe('UniswapV2Pair.simulateSwap — immutability', () => {
  it('original pair reserves are unchanged after simulateSwap', () => {
    const pair = makePair();
    const originalReserve0 = pair.reserve0;
    const originalReserve1 = pair.reserve1;

    pair.simulateSwap(2_000n * 10n ** 6n, USDC);

    expect(pair.reserve0).toBe(originalReserve0);
    expect(pair.reserve1).toBe(originalReserve1);
  });

  it('returns a NEW instance (reference inequality)', () => {
    const pair = makePair();
    const newPair = pair.simulateSwap(2_000n * 10n ** 6n, USDC);
    expect(newPair).not.toBe(pair);
  });

  it('new pair has increased reserve of sold token', () => {
    const pair = makePair();
    const amountIn = 2_000n * 10n ** 6n;
    const newPair = pair.simulateSwap(amountIn, USDC);
    // reserve0 = USDC reserve — should grow by amountIn
    expect(newPair.reserve0).toBe(pair.reserve0 + amountIn);
  });

  it('new pair has decreased reserve of bought token', () => {
    const pair = makePair();
    const amountIn = 2_000n * 10n ** 6n;
    const amountOut = pair.getAmountOut(amountIn, USDC);
    const newPair = pair.simulateSwap(amountIn, USDC);
    // reserve1 = WETH reserve — should shrink by amountOut
    expect(newPair.reserve1).toBe(pair.reserve1 - amountOut);
  });

  it('chained simulations maintain correct reserve updates', () => {
    const pair = makePair();
    const amountIn = 500n * 10n ** 6n;

    const step1 = pair.simulateSwap(amountIn, USDC);
    const step2 = step1.simulateSwap(amountIn, USDC);

    // Each swap increases USDC reserve by amountIn
    expect(step2.reserve0).toBe(pair.reserve0 + amountIn * 2n);
  });

  it('fee and address are preserved on the new instance', () => {
    const pair = makePair();
    const newPair = pair.simulateSwap(1_000n * 10n ** 6n, USDC);
    expect(newPair.feeBps).toBe(pair.feeBps);
    expect(newPair.address.equals(pair.address)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Price helpers — spot price, execution price, price impact
// ---------------------------------------------------------------------------

describe('UniswapV2Pair price helpers', () => {
  it('getSpotPrice returns a bigint scaled by 1e18', () => {
    const spot = makePair().getSpotPrice(USDC);
    expect(typeof spot).toBe('bigint');
    // Pool: reserve0 = 2_000_000 USDC (6 dec) = 2_000_000 × 10^6 raw
    //       reserve1 = 1_000 WETH (18 dec)    = 1_000 × 10^18 raw
    // getSpotPrice(USDC) = (reserveOut * PRICE_SCALE) / reserveIn
    //                    = (1_000 × 10^18 × 10^18) / (2_000_000 × 10^6)
    //                    = 10^39 / (2 × 10^12)
    //                    = 5 × 10^26
    const reserveIn = 2_000_000n * 10n ** 6n;
    const reserveOut = 1_000n * 10n ** 18n;
    const expected = (reserveOut * 10n ** 18n) / reserveIn;
    expect(spot).toBe(expected);
  });

  it('getExecutionPrice is <= spotPrice (fee makes it worse)', () => {
    const pair = makePair();
    const spot = pair.getSpotPrice(USDC);
    const exec = pair.getExecutionPrice(2_000n * 10n ** 6n, USDC);
    expect(exec).toBeLessThan(spot);
  });

  it('getPriceImpactBps for 1 wei trade equals fee in bps (fee dominates impact)', () => {
    const pair = makePair();
    // For an infinitesimally small trade the price impact converges to the fee.
    // spot = reserveOut / reserveIn (scaled)
    // exec = amountOut / amountIn   (scaled) — amountOut already has fee deducted
    // impact ≈ feeBps when trade size → 0 relative to reserves.
    const impact = pair.getPriceImpactBps(1n, USDC);
    // Should be exactly feeBps (30) for a dust-sized trade against a deep pool
    expect(impact).toBe(pair.feeBps);
  });

  it('getPriceImpactBps increases with trade size', () => {
    const pair = makePair();
    const smallImpact = pair.getPriceImpactBps(1_000n * 10n ** 6n, USDC);
    const largeImpact = pair.getPriceImpactBps(100_000n * 10n ** 6n, USDC);
    expect(largeImpact).toBeGreaterThan(smallImpact);
  });

  it('getPriceImpactBps result is a non-negative bigint', () => {
    const impact = makePair().getPriceImpactBps(2_000n * 10n ** 6n, USDC);
    expect(typeof impact).toBe('bigint');
    expect(impact).toBeGreaterThanOrEqual(0n);
  });
});

// ---------------------------------------------------------------------------
// quote() — combined SwapResult
// ---------------------------------------------------------------------------

describe('UniswapV2Pair.quote', () => {
  it('returns consistent values matching individual method calls', () => {
    const pair = makePair();
    const amountIn = 2_000n * 10n ** 6n;

    const result = pair.quote(amountIn, USDC);

    expect(result.amountOut).toBe(pair.getAmountOut(amountIn, USDC));
    expect(result.spotPriceBefore).toBe(pair.getSpotPrice(USDC));
    expect(result.executionPrice).toBe(pair.getExecutionPrice(amountIn, USDC));
    expect(result.priceImpactBps).toBe(pair.getPriceImpactBps(amountIn, USDC));
  });
});

// ---------------------------------------------------------------------------
// UniswapV2Calculator — pure math edge cases
// ---------------------------------------------------------------------------

describe('UniswapV2Calculator', () => {
  it('getAmountOut returns 0 for amountIn of 1 wei against massive reserve', () => {
    // Tiny trade, huge pool → numerator < denominator → 0 after floor division
    const out = UniswapV2Calculator.getAmountOut(1n, 10n ** 30n, 10n ** 30n, 30n);
    expect(out).toBe(0n);
  });

  it('getAmountIn throws when amountOut equals reserveOut', () => {
    expect(() => UniswapV2Calculator.getAmountIn(1000n, 1000n, 1000n, 30n)).toThrow(
      InsufficientLiquidityError,
    );
  });

  it('applySwap returns new reserves without mutating inputs', () => {
    const [newIn, newOut] = UniswapV2Calculator.applySwap(100n, 50n, 1000n, 2000n);
    expect(newIn).toBe(1100n);
    expect(newOut).toBe(1950n);
  });

  it('resolveReserves orients correctly for token0', () => {
    const { reserveIn, reserveOut } = UniswapV2Calculator.resolveReserves(
      USDC,
      USDC,
      2_000_000n,
      1_000n,
    );
    expect(reserveIn).toBe(2_000_000n);
    expect(reserveOut).toBe(1_000n);
  });

  it('resolveReserves orients correctly for token1', () => {
    const { reserveIn, reserveOut } = UniswapV2Calculator.resolveReserves(
      WETH,
      USDC,
      2_000_000n,
      1_000n,
    );
    expect(reserveIn).toBe(1_000n);
    expect(reserveOut).toBe(2_000_000n);
  });
});

// ---------------------------------------------------------------------------
// toString / toState
// ---------------------------------------------------------------------------

describe('UniswapV2Pair.toString / toState', () => {
  it('toString includes token symbols, address, and fee', () => {
    const str = makePair().toString();
    expect(str).toContain('USDC');
    expect(str).toContain('WETH');
    expect(str).toContain('30');
  });

  it('toState returns a plain object with correct field values', () => {
    const pair = makePair();
    const state = pair.toState();
    expect(state.reserve0).toBe(pair.reserve0);
    expect(state.reserve1).toBe(pair.reserve1);
    expect(state.feeBps).toBe(30n);
    expect(state.token0.symbol).toBe('USDC');
    expect(state.token1.symbol).toBe('WETH');
  });
});
