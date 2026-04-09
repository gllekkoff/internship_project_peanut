import type { Token } from '@/core/core.types';
import { UniswapV2Calculator } from '@/pricing/uniswap-v2/uniswap-v2.calculator';
import type { UniswapV2Pair } from '@/pricing/uniswap-v2/uniswap-v2.service';
import type { ImpactRow, TrueCostResult } from '@/pricing/uniswap-v2/uniswap-v2.types';

export class PriceImpactAnalyzer {
  private readonly pair: UniswapV2Pair;

  constructor(pair: UniswapV2Pair) {
    this.pair = pair;
  }

  /**
   * Generates a table of swap metrics for each provided trade size.
   *
   * @param tokenIn The token being sold.
   * @param sizes   List of raw input amounts to analyse (bigint, token-native units).
   * @returns       One {@link ImpactRow} per entry in `sizes`, in the same order.
   */
  generateImpactTable(tokenIn: Token, sizes: bigint[]): ImpactRow[] {
    return sizes.map((amountIn) => {
      const { amountOut, spotPriceBefore, executionPrice, priceImpactBps } = this.pair.quote(
        amountIn,
        tokenIn,
      );
      return { amountIn, amountOut, spotPriceBefore, executionPrice, priceImpactBps };
    });
  }

  /**
   * Binary-searches for the largest input amount whose price impact stays at or
   * below `maxImpactBps`.
   *
   * @param tokenIn      Token being sold.
   * @param maxImpactBps Maximum tolerated impact in basis points (e.g. 100 = 1%).
   * @returns            Largest raw input amount satisfying the impact constraint,
   *                     or 0n if even a 1-wei trade exceeds the limit.
   */
  findMaxSizeForImpact(tokenIn: Token, maxImpactBps: bigint): bigint {
    // Even a 1-wei trade exceeds the limit (e.g. very small pool with high fee).
    if (this.pair.getPriceImpactBps(1n, tokenIn) > maxImpactBps) return 0n;

    const isToken0 = tokenIn.address.equals(this.pair.token0.address);
    const reserveIn = isToken0 ? this.pair.reserve0 : this.pair.reserve1;

    let lo = 1n;
    let hi = reserveIn;

    while (lo < hi) {
      // Bias mid toward hi so the loop always makes progress when lo + 1 = hi.
      const mid = (lo + hi + 1n) / 2n;
      if (this.pair.getPriceImpactBps(mid, tokenIn) <= maxImpactBps) {
        lo = mid;
      } else {
        hi = mid - 1n;
      }
    }

    return lo;
  }

  /**
   * Estimates total swap cost including gas, expressed in output-token units.
   *
   * Gas is always denominated in ETH wei internally. To express it in the
   * output token we need an ETH→output-token exchange rate. Pass
   * `ethPriceInOutputToken` as a 1e18-scaled value:
   *
   * @param amountIn               Raw input amount (token-native units).
   * @param tokenIn                Token being sold.
   * @param gasPriceGwei           Current gas price in gwei (bigint).
   * @param gasEstimate            Estimated gas units consumed (default 150 000).
   * @param ethPriceInOutputToken  1e18-scaled ETH price in output-token units.
   *                               Defaults to PRICE_SCALE (assumes output = WETH).
   * @returns                      {@link TrueCostResult} with all cost components.
   */
  estimateTrueCost(
    amountIn: bigint,
    tokenIn: Token,
    gasPriceGwei: bigint,
    gasEstimate: bigint = 150_000n,
    ethPriceInOutputToken: bigint = UniswapV2Calculator.PRICE_SCALE,
  ): TrueCostResult {
    const grossOutput = this.pair.getAmountOut(amountIn, tokenIn);

    const gasCostEth = gasPriceGwei * 1_000_000_000n * gasEstimate;

    const gasCostInOutputToken =
      (gasCostEth * ethPriceInOutputToken) / UniswapV2Calculator.PRICE_SCALE;

    // Net output floored at 0 — a negative net output means the trade is gas-negative.
    const netOutput = grossOutput > gasCostInOutputToken ? grossOutput - gasCostInOutputToken : 0n;

    // Effective price: 0 when the trade is gas-negative (avoids division by zero edge cases).
    const effectivePrice =
      netOutput > 0n ? UniswapV2Calculator.getExecutionPrice(amountIn, netOutput) : 0n;

    return { grossOutput, gasCostEth, gasCostInOutputToken, netOutput, effectivePrice };
  }
}
