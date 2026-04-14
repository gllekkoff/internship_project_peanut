import { createPublicClient, http, type Hex, type PublicClient } from 'viem';
import { Address } from '@/core/core.types';
import type { Token } from '@/core/core.types';
import type { UniswapV2Pair } from '@/pricing/uniswap-v2/uniswap-v2.service';
import type { Route } from '@/pricing/routing/routing.service';
import { ROUTER_ABI, DEFAULT_DEADLINE_OFFSET, SIMULATION_AMOUNT_OUT_MIN } from './fork.constants';
import type { ComparisonResult, SimulationResult } from './fork.interfaces';

// Uniswap V2 Router02 on mainnet — used for getAmountsOut view calls in compareSimulationVsCalculation.
const DEFAULT_ROUTER = new Address('0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D');

/** Simulates swaps and routes against a local Anvil/Hardhat fork via eth_call — no tx is broadcast. */
export class ForkSimulator {
  private readonly client: PublicClient;
  private readonly router: Address;

  constructor(forkUrl: string, router: Address = DEFAULT_ROUTER) {
    this.client = createPublicClient({ transport: http(forkUrl) });
    this.router = router;
  }

  /** Calls swapExactTokensForTokens via eth_call on the fork; returns amountOut, gas, and logs without submitting. */
  async simulateSwap(
    router: Address,
    amountIn: bigint,
    path: readonly `0x${string}`[],
    sender: Address,
  ): Promise<SimulationResult> {
    const deadline = BigInt(Math.floor(Date.now() / 1000)) + DEFAULT_DEADLINE_OFFSET;

    // Address.value is validated checksummed hex; cast to Hex is safe here.
    const contractParams = {
      address: router.value as Hex,
      abi: ROUTER_ABI,
      functionName: 'swapExactTokensForTokens',
      args: [amountIn, SIMULATION_AMOUNT_OUT_MIN, [...path], sender.value as Hex, deadline],
      account: sender.value as Hex,
    } as const;

    try {
      const [{ result: amounts }, gasUsed] = await Promise.all([
        this.client.simulateContract(contractParams),
        this.client.estimateContractGas(contractParams).catch(() => 0n),
      ]);

      // amounts is [amountIn, ...intermediates, amountOut]; last element is what the caller receives.
      const amountOut = amounts.at(-1) ?? 0n;
      return { success: true, amountOut, gasUsed, error: null, logs: [] };
    } catch (e) {
      return {
        success: false,
        amountOut: 0n,
        gasUsed: 0n,
        error: e instanceof Error ? e.message : String(e),
        logs: [],
      };
    }
  }

  /** Simulates a Route by building the token address path from Route.path and calling the stored router via eth_call. */
  async simulateRoute(route: Route, amountIn: bigint, sender: Address): Promise<SimulationResult> {
    const path = route.path.map((t) => t.address.value as `0x${string}`);
    return this.simulateSwap(this.router, amountIn, path, sender);
  }

  /** Compares UniswapV2Calculator's getAmountOut against the router's getAmountsOut on the fork — validates our AMM math. */
  async compareSimulationVsCalculation(
    pair: UniswapV2Pair,
    amountIn: bigint,
    tokenIn: Token,
  ): Promise<ComparisonResult> {
    const calculated = pair.getAmountOut(amountIn, tokenIn);
    const tokenOut = tokenIn.address.equals(pair.token0.address) ? pair.token1 : pair.token0;

    const amounts = await this.client.readContract({
      address: this.router.value as Hex,
      abi: ROUTER_ABI,
      functionName: 'getAmountsOut',
      args: [
        amountIn,
        [tokenIn.address.value as `0x${string}`, tokenOut.address.value as `0x${string}`],
      ],
    });

    // amounts[0] = amountIn, amounts[1] = amountOut for a single-hop path.
    const simulated = amounts.at(1) ?? 0n;
    const difference = calculated > simulated ? calculated - simulated : simulated - calculated;

    return { calculated, simulated, difference, match: calculated === simulated };
  }
}
