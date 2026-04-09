import {
  createPublicClient,
  encodeFunctionData,
  decodeFunctionResult,
  http,
  type Hex,
  type PublicClient,
} from 'viem';
import type { Address, Token } from '@/core/core.types';
import type { UniswapV2Pair } from '@/pricing/uniswap-v2/uniswap-v2.service';
import type { Route } from '@/pricing/routing/routing.service';
import { ROUTER_ABI, DEFAULT_DEADLINE_OFFSET, SIMULATION_AMOUNT_OUT_MIN } from './fork.constants';
import type { ComparisonResult, SimulationResult } from './fork.interfaces';

/** Simulates swaps and routes against a local Anvil/Hardhat fork via eth_call — no tx is broadcast. */
export class ForkSimulator {
  private readonly client: PublicClient;

  constructor(forkUrl: string) {
    this.client = createPublicClient({ transport: http(forkUrl) });
  }

  /** Calls swapExactTokensForTokens via eth_call on the fork; returns amountOut and gas without submitting. */
  async simulateSwap(
    router: Address,
    amountIn: bigint,
    path: readonly `0x${string}`[],
    sender: Address,
  ): Promise<SimulationResult> {
    const deadline = BigInt(Math.floor(Date.now() / 1000)) + DEFAULT_DEADLINE_OFFSET;

    // Address.value is validated checksummed hex; cast to Hex is safe here.
    const routerHex = router.value as Hex;
    const senderHex = sender.value as Hex;

    const calldata = encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: 'swapExactTokensForTokens',
      args: [amountIn, SIMULATION_AMOUNT_OUT_MIN, [...path], senderHex, deadline],
    });

    const callParams = { to: routerHex, data: calldata, account: senderHex };

    try {
      const [callResult, gasUsed] = await Promise.all([
        this.client.call(callParams),
        // estimateGas throws on revert; fall back to 0n so simulateSwap still returns a result.
        this.client.estimateGas(callParams).catch(() => 0n),
      ]);

      const amounts = decodeFunctionResult({
        abi: ROUTER_ABI,
        functionName: 'swapExactTokensForTokens',
        data: callResult.data ?? '0x',
      });

      // amounts is [amountIn, ...intermediates, amountOut]; last element is what the caller receives.
      const amountOut = amounts.at(-1) ?? 0n;

      return { success: true, amountOut, gasUsed, error: null };
    } catch (e) {
      return {
        success: false,
        amountOut: 0n,
        gasUsed: 0n,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /** Simulates a Route by building the token address path from Route.path and calling the given router via eth_call. */
  async simulateRoute(
    route: Route,
    amountIn: bigint,
    sender: Address,
    router: Address,
  ): Promise<SimulationResult> {
    const path = route.path.map((t) => t.address.value as `0x${string}`);
    return this.simulateSwap(router, amountIn, path, sender);
  }

  /** Compares UniswapV2Calculator's getAmountOut against the router's getAmountsOut on the fork — validates our AMM math. */
  async compareSimulationVsCalculation(
    router: Address,
    pair: UniswapV2Pair,
    amountIn: bigint,
    tokenIn: Token,
  ): Promise<ComparisonResult> {
    const calculated = pair.getAmountOut(amountIn, tokenIn);

    const tokenOut = tokenIn.address.equals(pair.token0.address) ? pair.token1 : pair.token0;

    // Address.value is validated checksummed hex; cast to 0x${string} required by viem ABI encoder.
    const path: [`0x${string}`, `0x${string}`] = [
      tokenIn.address.value as `0x${string}`,
      tokenOut.address.value as `0x${string}`,
    ];

    const calldata = encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: 'getAmountsOut',
      args: [amountIn, path],
    });

    const callResult = await this.client.call({ to: router.value as Hex, data: calldata });

    const amounts = decodeFunctionResult({
      abi: ROUTER_ABI,
      functionName: 'getAmountsOut',
      data: callResult.data ?? '0x',
    });

    // amounts[0] = amountIn, amounts[1] = amountOut for a single-hop path.
    const simulated = amounts.at(1) ?? 0n;
    const difference = calculated > simulated ? calculated - simulated : simulated - calculated;

    return { calculated, simulated, difference, match: calculated === simulated };
  }
}
