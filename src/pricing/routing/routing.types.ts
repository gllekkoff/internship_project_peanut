import type { Token } from '@/core/core.types';
import type { UniswapV2Pair } from '@/pricing/uniswap-v2/uniswap-v2.service';
import type { Route } from './routing.service';

/** Single adjacency entry in the token graph: one pool reachable from a token. */
export interface GraphEdge {
  readonly pool: UniswapV2Pair;
  readonly otherToken: Token;
}

/** Adjacency map: token address (lowercase) → list of reachable pools. */
export type RouteGraph = Map<string, GraphEdge[]>;

/** Per-route breakdown returned by RouteFinder.compareRoutes. */
export interface RouteComparison {
  readonly route: Route;
  /** Raw output before gas deduction, in output-token units. */
  readonly grossOutput: bigint;
  /** Estimated gas consumption in gas units. */
  readonly gasEstimate: bigint;
  /** Gas cost in ETH wei (gasPriceGwei * 1e9 * gasEstimate). */
  readonly gasCost: bigint;
  /** grossOutput minus gas cost converted to output-token units (floored at 0). */
  readonly netOutput: bigint;
}
