import type { Token } from '@/core/core.types';
import { InsufficientLiquidityError } from './uniswap-v2.errors';

/** Pure Uniswap V2 AMM math — constant-product formula with configurable fee */
export class UniswapV2Calculator {
  static readonly PRICE_SCALE = 10n ** 18n;

  static getAmountOut(
    amountIn: bigint,
    reserveIn: bigint,
    reserveOut: bigint,
    feeBps: bigint,
  ): bigint {
    if (amountIn <= 0n) throw new InsufficientLiquidityError('amountIn must be > 0');
    if (reserveIn <= 0n || reserveOut <= 0n)
      throw new InsufficientLiquidityError('Reserves must be > 0');

    const amountInWithFee = amountIn * (10_000n - feeBps);
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn * 10_000n + amountInWithFee;

    return numerator / denominator;
  }

  static getAmountIn(
    amountOut: bigint,
    reserveIn: bigint,
    reserveOut: bigint,
    feeBps: bigint,
  ): bigint {
    if (amountOut <= 0n) throw new InsufficientLiquidityError('amountOut must be > 0');
    if (reserveIn <= 0n || reserveOut <= 0n)
      throw new InsufficientLiquidityError('Reserves must be > 0');
    if (amountOut >= reserveOut)
      throw new InsufficientLiquidityError('amountOut must be < reserveOut');

    const numerator = reserveIn * amountOut * 10_000n;
    const denominator = (reserveOut - amountOut) * (10_000n - feeBps);

    return numerator / denominator + 1n;
  }

  static getSpotPrice(reserveIn: bigint, reserveOut: bigint): bigint {
    if (reserveIn <= 0n) throw new InsufficientLiquidityError('reserveIn must be > 0');
    if (reserveOut <= 0n) throw new InsufficientLiquidityError('reserveOut must be > 0');

    return (reserveOut * UniswapV2Calculator.PRICE_SCALE) / reserveIn;
  }

  static getExecutionPrice(amountIn: bigint, amountOut: bigint): bigint {
    if (amountIn <= 0n) throw new InsufficientLiquidityError('amountIn must be > 0');
    if (amountOut <= 0n) throw new InsufficientLiquidityError('amountOut must be > 0');

    return (amountOut * UniswapV2Calculator.PRICE_SCALE) / amountIn;
  }

  /** How much worse than spot your execution price was, in basis points (100 bps = 1%). */
  static getPriceImpactBps(spotPrice: bigint, executionPrice: bigint): bigint {
    if (spotPrice <= 0n) throw new InsufficientLiquidityError('spotPrice must be > 0');
    if (executionPrice <= 0n) throw new InsufficientLiquidityError('executionPrice must be > 0');

    return ((spotPrice - executionPrice) * 10_000n) / spotPrice;
  }

  /** New reserve state after a completed swap; does not validate inputs. */
  static applySwap(
    amountIn: bigint,
    amountOut: bigint,
    reserveIn: bigint,
    reserveOut: bigint,
  ): [bigint, bigint] {
    return [reserveIn + amountIn, reserveOut - amountOut];
  }

  /** Maps token0/token1 reserves to reserveIn/reserveOut relative to which token is being sold. */
  static resolveReserves(
    tokenIn: Token,
    token0: Token,
    reserve0: bigint,
    reserve1: bigint,
  ): { reserveIn: bigint; reserveOut: bigint } {
    const isToken0 = tokenIn.address.equals(token0.address);
    return isToken0
      ? { reserveIn: reserve0, reserveOut: reserve1 }
      : { reserveIn: reserve1, reserveOut: reserve0 };
  }
}
