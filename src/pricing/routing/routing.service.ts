import type { Token } from '@/core/core.types';
import type { UniswapV2Pair } from '@/pricing/uniswap-v2/uniswap-v2.service';
import { UniswapV2Calculator } from '@/pricing/uniswap-v2/uniswap-v2.calculator';
import { InvalidRouteError, NoRouteFoundError } from './routing.errors';
import type { GraphEdge, RouteComparison, RouteGraph } from './routing.types';

// Gas model: 150k base overhead + 100k per AMM swap hop.
const GAS_BASE = 150_000n;
const GAS_PER_HOP = 100_000n;

/**
 * Immutable snapshot of a swap path through one or more UniswapV2 pools.
 *
 * path has exactly pools.length + 1 entries:
 *   path[0] = tokenIn, path[n] = tokenOut, intermediates in between.
 * Each pool[i] must contain path[i] and path[i+1] as its two tokens.
 */
export class Route {
  readonly pools: readonly UniswapV2Pair[];
  readonly path: readonly Token[];

  constructor(pools: UniswapV2Pair[], path: Token[]) {
    if (path.length !== pools.length + 1) {
      throw new InvalidRouteError(
        `path length (${path.length}) must be pools.length + 1 (${pools.length + 1})`,
      );
    }
    this.pools = pools;
    this.path = path;
  }

  get numHops(): number {
    return this.pools.length;
  }

  /**
   * Simulates the full route and returns the final output amount.
   * Each hop calls getAmountOut on the respective pool.
   */
  getOutput(amountIn: bigint): bigint {
    let amount = amountIn;
    for (let i = 0; i < this.pools.length; i++) {
      amount = this.pools[i]!.getAmountOut(amount, this.path[i]!);
    }
    return amount;
  }

  /**
   * Returns the running amount at every step: [input, after_hop1, after_hop2, ...].
   * Length = pools.length + 1.
   */
  getIntermediateAmounts(amountIn: bigint): bigint[] {
    const amounts: bigint[] = [amountIn];
    for (let i = 0; i < this.pools.length; i++) {
      amounts.push(this.pools[i]!.getAmountOut(amounts[amounts.length - 1]!, this.path[i]!));
    }
    return amounts;
  }

  /** ~150k base + 100k per hop, matching typical Uniswap V2 on-chain gas. */
  estimateGas(): bigint {
    return GAS_BASE + BigInt(this.pools.length) * GAS_PER_HOP;
  }

  toString(): string {
    return this.path.map((t) => t.symbol).join(' → ');
  }
}

/**
 * Finds optimal swap routes through a set of UniswapV2 pools.
 *
 * Internally builds a bidirectional token adjacency graph at construction time.
 * Route search uses DFS with pool-visit deduplication to avoid cycles.
 *
 * Gas cost is converted to output-token units using ethPriceInOutputToken
 * (1e18-scaled). Defaults to PRICE_SCALE, which assumes the output token is
 * WETH (1 ETH = 1e18 output units). Pass the correct rate for other tokens:
 *   ethPriceInOutputToken = humanOutputPerEth * 10^outputDecimals
 * Example — output = USDC (6 dec), 1 ETH = 2000 USDC:
 *   ethPriceInOutputToken = 2000n * 10n**6n
 */
export class RouteFinder {
  readonly pools: readonly UniswapV2Pair[];
  private readonly graph: RouteGraph;

  constructor(pools: UniswapV2Pair[]) {
    this.pools = pools;
    this.graph = this.buildGraph();
  }

  private buildGraph(): RouteGraph {
    const graph: RouteGraph = new Map();

    const addEdge = (from: Token, edge: GraphEdge): void => {
      const key = from.address.lower;
      const existing = graph.get(key);
      if (existing) {
        existing.push(edge);
      } else {
        graph.set(key, [edge]);
      }
    };

    for (const pool of this.pools) {
      addEdge(pool.token0, { pool, otherToken: pool.token1 });
      addEdge(pool.token1, { pool, otherToken: pool.token0 });
    }

    return graph;
  }

  /**
   * DFS over the token graph to enumerate all acyclic routes (no pool reuse)
   * up to maxHops deep.
   */
  findAllRoutes(tokenIn: Token, tokenOut: Token, maxHops = 3): Route[] {
    const routes: Route[] = [];

    const dfs = (
      current: Token,
      poolsAcc: UniswapV2Pair[],
      pathAcc: Token[],
      visitedPools: Set<string>,
    ): void => {
      for (const { pool, otherToken } of this.graph.get(current.address.lower) ?? []) {
        if (visitedPools.has(pool.address.lower)) continue;

        const nextPools = [...poolsAcc, pool];
        const nextPath = [...pathAcc, otherToken];
        const nextVisited = new Set(visitedPools).add(pool.address.lower);

        if (otherToken.address.equals(tokenOut.address)) {
          routes.push(new Route(nextPools, nextPath));
        } else if (nextPools.length < maxHops) {
          dfs(otherToken, nextPools, nextPath, nextVisited);
        }
      }
    };

    dfs(tokenIn, [], [tokenIn], new Set());
    return routes;
  }

  /**
   * Returns the route with the highest net output (gross output minus gas cost
   * converted to output-token units), along with that net output amount.
   */
  findBestRoute(
    tokenIn: Token,
    tokenOut: Token,
    amountIn: bigint,
    gasPriceGwei: bigint,
    maxHops = 3,
    ethPriceInOutputToken = UniswapV2Calculator.PRICE_SCALE,
  ): [Route, bigint] {
    const routes = this.findAllRoutes(tokenIn, tokenOut, maxHops);
    if (routes.length === 0) throw new NoRouteFoundError(tokenIn.symbol, tokenOut.symbol);

    let bestRoute = routes[0]!;
    let bestNet = this.netOutput(routes[0]!, amountIn, gasPriceGwei, ethPriceInOutputToken);

    for (let i = 1; i < routes.length; i++) {
      const net = this.netOutput(routes[i]!, amountIn, gasPriceGwei, ethPriceInOutputToken);
      if (net > bestNet) {
        bestNet = net;
        bestRoute = routes[i]!;
      }
    }

    return [bestRoute, bestNet];
  }

  /**
   * Returns a full cost breakdown for every found route, sorted descending by
   * net output.
   */
  compareRoutes(
    tokenIn: Token,
    tokenOut: Token,
    amountIn: bigint,
    gasPriceGwei: bigint,
    maxHops = 3,
    ethPriceInOutputToken = UniswapV2Calculator.PRICE_SCALE,
  ): RouteComparison[] {
    return this.findAllRoutes(tokenIn, tokenOut, maxHops)
      .map((route) => {
        const grossOutput = route.getOutput(amountIn);
        const gasEstimate = route.estimateGas();
        const gasCost = gasPriceGwei * 1_000_000_000n * gasEstimate;
        const gasCostInOutput = (gasCost * ethPriceInOutputToken) / UniswapV2Calculator.PRICE_SCALE;
        const netOutput = grossOutput > gasCostInOutput ? grossOutput - gasCostInOutput : 0n;
        return { route, grossOutput, gasEstimate, gasCost, netOutput };
      })
      .sort((a, b) => (a.netOutput > b.netOutput ? -1 : 1));
  }

  private netOutput(
    route: Route,
    amountIn: bigint,
    gasPriceGwei: bigint,
    ethPriceInOutputToken: bigint,
  ): bigint {
    const grossOutput = route.getOutput(amountIn);
    const gasCostEth = gasPriceGwei * 1_000_000_000n * route.estimateGas();
    const gasCostInOutput = (gasCostEth * ethPriceInOutputToken) / UniswapV2Calculator.PRICE_SCALE;
    return grossOutput > gasCostInOutput ? grossOutput - gasCostInOutput : 0n;
  }
}
