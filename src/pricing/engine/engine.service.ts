import type { ChainClient } from '@/chain/chain.client';
import { Address } from '@/core/core.types';
import type { Token } from '@/core/core.types';
import { ForkSimulator } from '@/pricing/forkSimulator/fork.service';
import { MempoolMonitor, type ParsedSwap } from '@/pricing/mempool/mempool.service';
import { UniswapV2Pair } from '@/pricing/uniswap-v2/uniswap-v2.service';
import { RouteFinder } from '@/pricing/routing/routing.service';
import { QuoteError } from './engine.errors';
import { Quote } from './engine.types';

/** Orchestrates AMM math, routing, fork simulation, and mempool monitoring into a single pricing interface. */
export class PricingEngine {
  private readonly simulator: ForkSimulator;
  private readonly monitor: MempoolMonitor;
  // Keyed by address.lower so Address class instances can be used for lookup.
  private readonly pools: Map<string, UniswapV2Pair> = new Map();
  private router: RouteFinder | null = null;

  constructor(
    private readonly chainClient: ChainClient,
    forkUrl: string,
    wsUrl: string,
  ) {
    this.simulator = new ForkSimulator(forkUrl);
    this.monitor = new MempoolMonitor(wsUrl, (swap) => this.onMempoolSwap(swap));
  }

  /** Fetches all pool states from chain in parallel and rebuilds the route graph. */
  async loadPools(poolAddresses: Address[]): Promise<void> {
    const pairs = await Promise.all(
      poolAddresses.map((addr) => UniswapV2Pair.fromChain(addr, this.chainClient)),
    );
    for (const pair of pairs) {
      this.pools.set(pair.address.lower, pair);
    }
    this.router = new RouteFinder([...this.pools.values()]);
  }

  /** Re-fetches reserves for a single pool and patches the route graph in-place — O(edges), not O(pools). */
  async refreshPool(address: Address): Promise<void> {
    const pair = await UniswapV2Pair.fromChain(address, this.chainClient);
    this.pools.set(pair.address.lower, pair);
    if (this.router) {
      this.router.updatePool(pair);
    }
  }

  /** Finds the best route, verifies it via fork simulation, and returns a Quote; throws QuoteError if simulation fails or no route exists. */
  async getQuote(
    tokenIn: Token,
    tokenOut: Token,
    amountIn: bigint,
    gasPriceGwei: bigint,
    sender: Address,
  ): Promise<Quote> {
    if (!this.router) throw new QuoteError('No pools loaded — call loadPools first');

    let route, expectedOutput: bigint;
    try {
      [route, expectedOutput] = this.router.findBestRoute(
        tokenIn,
        tokenOut,
        amountIn,
        gasPriceGwei,
      );
    } catch (e) {
      throw new QuoteError('No route found', { cause: e });
    }

    const simResult = await this.simulator.simulateRoute(route, amountIn, sender);

    if (!simResult.success) {
      throw new QuoteError(`Simulation failed: ${simResult.error ?? 'unknown error'}`);
    }

    return new Quote(
      route,
      amountIn,
      expectedOutput,
      simResult.amountOut,
      simResult.gasUsed,
      Date.now(),
    );
  }

  /**
   * Returns the AMM output amount using pool math only — no fork simulation.
   * Much faster than getQuote; suitable for signal generation where latency matters.
   * Throws QuoteError if no pools are loaded or no route exists.
   */
  getAmmQuote(tokenIn: Token, tokenOut: Token, amountIn: bigint): bigint {
    if (!this.router) throw new QuoteError('No pools loaded — call loadPools first');
    let expectedOutput: bigint;
    try {
      [, expectedOutput] = this.router.findBestRoute(tokenIn, tokenOut, amountIn, 0n);
    } catch (e) {
      throw new QuoteError('No route found', { cause: e });
    }
    return expectedOutput;
  }

  /** Starts the WebSocket mempool subscription. */
  async startMonitor(): Promise<void> {
    await this.monitor.start();
  }

  /** Stops the WebSocket mempool subscription. */
  stopMonitor(): void {
    this.monitor.stop();
  }

  /** Refreshes any pool affected by the detected mempool swap so quotes stay current. */
  private onMempoolSwap(swap: ParsedSwap): void {
    const affectedAddresses: Address[] = [];
    for (const pair of this.pools.values()) {
      const tokenInMatch =
        swap.tokenIn !== null &&
        (pair.token0.address.equals(swap.tokenIn) || pair.token1.address.equals(swap.tokenIn));
      const tokenOutMatch =
        swap.tokenOut !== null &&
        (pair.token0.address.equals(swap.tokenOut) || pair.token1.address.equals(swap.tokenOut));
      if (tokenInMatch || tokenOutMatch) affectedAddresses.push(pair.address);
    }

    for (const addr of affectedAddresses) {
      // Fire-and-forget: refresh errors are logged, not propagated to the monitor callback.
      void this.refreshPool(addr).catch((e) =>
        console.error(`[PricingEngine] Failed to refresh pool ${addr.value}:`, e),
      );
    }
  }
}
