import { erc20Abi, parseAbi, decodeFunctionResult, encodeFunctionData } from 'viem';
import { Token, TokenAmount, TransactionRequest, Address } from '@/core/core.types';
import type { ChainClient } from '@/chain/chain.client';
import { UniswapV2Calculator } from './uniswap-v2.calculator';
import type { UniswapV2PairState, SwapResult } from './uniswap-v2.types';
import { InvalidPairError, UnknownTokenError } from './uniswap-v2.errors';

// Uniswap V2 pair ABI — not bundled in viem; defined here as human-readable strings via parseAbi.
const PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);

/** Immutable snapshot of a Uniswap V2 pair; all swap/price math delegates to UniswapV2Calculator. */
export class UniswapV2Pair {
  readonly address: Address;
  readonly token0: Token;
  readonly token1: Token;
  readonly reserve0: bigint;
  readonly reserve1: bigint;
  /** Fee in basis points — standard Uniswap V2 is 30 bps (0.30%). */
  readonly feeBps: bigint;

  constructor(
    address: Address,
    token0: Token,
    token1: Token,
    reserve0: bigint,
    reserve1: bigint,
    feeBps: bigint = 30n,
  ) {
    this.address = address;
    this.token0 = token0;
    this.token1 = token1;
    this.reserve0 = reserve0;
    this.reserve1 = reserve1;
    this.feeBps = feeBps;
  }

  /** Raw output tokens you receive for selling `amountIn` of `tokenIn` into this pool. */
  getAmountOut(amountIn: bigint, tokenIn: Token): bigint {
    const { reserveIn, reserveOut } = this.resolveReserves(tokenIn);
    return UniswapV2Calculator.getAmountOut(amountIn, reserveIn, reserveOut, this.feeBps);
  }

  /** Minimum raw input needed to receive exactly `amountOut` of `tokenOut`; rounds up to match Solidity. */
  getAmountIn(amountOut: bigint, tokenOut: Token): bigint {
    // resolveReserves takes tokenIn; we pass the other side because tokenOut is what we receive.
    const { reserveIn, reserveOut } = this.resolveReserves(this.otherToken(tokenOut));
    return UniswapV2Calculator.getAmountIn(amountOut, reserveIn, reserveOut, this.feeBps);
  }

  /** Instantaneous price of `tokenIn` denominated in the other token, scaled by 1e18. Display-only — ignores fees and size. */
  getSpotPrice(tokenIn: Token): bigint {
    const { reserveIn, reserveOut } = this.resolveReserves(tokenIn);
    return UniswapV2Calculator.getSpotPrice(reserveIn, reserveOut);
  }

  /** Effective price you get for selling `amountIn`, scaled by 1e18 — accounts for fee but not multi-hop slippage. */
  getExecutionPrice(amountIn: bigint, tokenIn: Token): bigint {
    const amountOut = this.getAmountOut(amountIn, tokenIn);
    return UniswapV2Calculator.getExecutionPrice(amountIn, amountOut);
  }

  /** Price impact of selling `amountIn` in basis points (100 bps = 1%). */
  getPriceImpactBps(amountIn: bigint, tokenIn: Token): bigint {
    const spot = this.getSpotPrice(tokenIn);
    const exec = this.getExecutionPrice(amountIn, tokenIn);
    return UniswapV2Calculator.getPriceImpactBps(spot, exec);
  }

  /** Returns a new UniswapV2Pair with reserves updated after the swap; does not mutate this instance. */
  simulateSwap(amountIn: bigint, tokenIn: Token): UniswapV2Pair {
    const amountOut = this.getAmountOut(amountIn, tokenIn);
    const isToken0In = tokenIn.address.equals(this.token0.address);

    let newReserve0: bigint;
    let newReserve1: bigint;
    if (isToken0In) {
      [newReserve0, newReserve1] = UniswapV2Calculator.applySwap(
        amountIn,
        amountOut,
        this.reserve0,
        this.reserve1,
      );
    } else {
      [newReserve1, newReserve0] = UniswapV2Calculator.applySwap(
        amountIn,
        amountOut,
        this.reserve1,
        this.reserve0,
      );
    }

    return new UniswapV2Pair(
      this.address,
      this.token0,
      this.token1,
      newReserve0,
      newReserve1,
      this.feeBps,
    );
  }

  /** Full swap quote in one call: amountOut, spot price, execution price, and price impact. */
  quote(amountIn: bigint, tokenIn: Token): SwapResult {
    const spotPriceBefore = this.getSpotPrice(tokenIn);
    const amountOut = this.getAmountOut(amountIn, tokenIn);
    const executionPrice = UniswapV2Calculator.getExecutionPrice(amountIn, amountOut);
    const priceImpactBps = UniswapV2Calculator.getPriceImpactBps(spotPriceBefore, executionPrice);

    return { amountOut, spotPriceBefore, executionPrice, priceImpactBps };
  }

  /** Fetches reserves, token addresses, symbols, and decimals from the chain and constructs a fully populated UniswapV2Pair. */
  static async fromChain(
    address: Address,
    client: ChainClient,
    feeBps: bigint = 30n,
  ): Promise<UniswapV2Pair> {
    const zeroValue = new TokenAmount(0n, 18, 'ETH');
    const makeCallData = (hex: `0x${string}`): Uint8Array => Buffer.from(hex.slice(2), 'hex');

    const call = (target: Address, hex: `0x${string}`) =>
      client.call(new TransactionRequest(target, zeroValue, makeCallData(hex)));

    const [reservesHex, token0Hex, token1Hex] = await Promise.all([
      call(address, encodeFunctionData({ abi: PAIR_ABI, functionName: 'getReserves' })),
      call(address, encodeFunctionData({ abi: PAIR_ABI, functionName: 'token0' })),
      call(address, encodeFunctionData({ abi: PAIR_ABI, functionName: 'token1' })),
    ]);

    const [reserve0, reserve1] = decodeFunctionResult({
      abi: PAIR_ABI,
      functionName: 'getReserves',
      data: reservesHex,
    });

    const token0Address = new Address(
      decodeFunctionResult({ abi: PAIR_ABI, functionName: 'token0', data: token0Hex }),
    );
    const token1Address = new Address(
      decodeFunctionResult({ abi: PAIR_ABI, functionName: 'token1', data: token1Hex }),
    );

    const [symbol0Hex, decimals0Hex, symbol1Hex, decimals1Hex] = await Promise.all([
      call(token0Address, encodeFunctionData({ abi: erc20Abi, functionName: 'symbol' })),
      call(token0Address, encodeFunctionData({ abi: erc20Abi, functionName: 'decimals' })),
      call(token1Address, encodeFunctionData({ abi: erc20Abi, functionName: 'symbol' })),
      call(token1Address, encodeFunctionData({ abi: erc20Abi, functionName: 'decimals' })),
    ]);

    const token0 = new Token(
      token0Address,
      decodeFunctionResult({ abi: erc20Abi, functionName: 'symbol', data: symbol0Hex }),
      decodeFunctionResult({ abi: erc20Abi, functionName: 'decimals', data: decimals0Hex }),
    );
    const token1 = new Token(
      token1Address,
      decodeFunctionResult({ abi: erc20Abi, functionName: 'symbol', data: symbol1Hex }),
      decodeFunctionResult({ abi: erc20Abi, functionName: 'decimals', data: decimals1Hex }),
    );

    if (!token0Address.value || !token1Address.value) {
      throw new InvalidPairError(address.value, 'token0 or token1 returned zero address');
    }

    return new UniswapV2Pair(address, token0, token1, reserve0, reserve1, feeBps);
  }

  /** Plain object snapshot of the pair state for logging or caching. */
  toState(): UniswapV2PairState {
    return {
      address: this.address,
      token0: this.token0,
      token1: this.token1,
      reserve0: this.reserve0,
      reserve1: this.reserve1,
      feeBps: this.feeBps,
    };
  }

  toString(): string {
    return (
      `UniswapV2Pair(${this.token0.symbol}/${this.token1.symbol} @ ${this.address.value} ` +
      `r0=${this.reserve0} r1=${this.reserve1} fee=${this.feeBps}bps)`
    );
  }

  /** Orients reserves as { reserveIn, reserveOut } for `tokenIn`; throws if token doesn't belong to this pair. */
  private resolveReserves(tokenIn: Token): { reserveIn: bigint; reserveOut: bigint } {
    if (
      !tokenIn.address.equals(this.token0.address) &&
      !tokenIn.address.equals(this.token1.address)
    ) {
      throw new UnknownTokenError(tokenIn.address.value, this.address.value);
    }
    return UniswapV2Calculator.resolveReserves(tokenIn, this.token0, this.reserve0, this.reserve1);
  }

  /** Returns the other token in the pair; throws if the given token doesn't belong here. */
  private otherToken(token: Token): Token {
    if (token.address.equals(this.token0.address)) return this.token1;
    if (token.address.equals(this.token1.address)) return this.token0;
    throw new UnknownTokenError(token.address.value, this.address.value);
  }
}
