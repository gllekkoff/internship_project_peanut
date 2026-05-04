import { createPublicClient, parseAbi, webSocket } from 'viem';
import type { Chain } from 'viem';
import { mainnet } from 'viem/chains';
import type { ChainClient } from '@/chain/chain.client';
import { makeLogger } from '@/core/core.logger';
import { Address } from '@/core/core.types';
import type { Token } from '@/core/core.types';
import { ForkSimulator } from '@/pricing/forkSimulator/fork.service';
import { MempoolMonitor, type ParsedSwap } from '@/pricing/mempool/mempool.service';
import { UniswapV2Pair } from '@/pricing/uniswap-v2/uniswap-v2.service';
import { RouteFinder } from '@/pricing/routing/routing.service';
import { QuoteError } from './engine.errors';
import { Quote } from './engine.types';

const log = makeLogger('PricingEngine');

// Sync(uint112 reserve0, uint112 reserve1) — fires on every Uniswap V2 swap/mint/burn.
const SYNC_ABI = parseAbi(['event Sync(uint112 reserve0, uint112 reserve1)']);

/** Orchestrates AMM math, routing, fork simulation, and mempool monitoring into a single pricing interface. */
export class PricingEngine {
  private readonly simulator: ForkSimulator;
  private readonly monitor: MempoolMonitor;
  // Keyed by address.lower so Address class instances can be used for lookup.
  private readonly pools: Map<string, UniswapV2Pair> = new Map();
  private poolMonitorRunning = false;
  private syncUnwatchers: (() => void)[] = [];
  private router: RouteFinder | null = null;
  /** Monotonically increasing counter per pool address — gaps in the log mean missed events. */
  private readonly syncCounters: Map<string, number> = new Map();

  constructor(
    private readonly chainClient: ChainClient,
    forkUrl: string,
    private readonly wsUrl: string,
    private readonly chain: Chain = mainnet,
    router: Address | null = null,
  ) {
    this.simulator = router ? new ForkSimulator(forkUrl, router) : new ForkSimulator(forkUrl);
    this.monitor = new MempoolMonitor(wsUrl, (swap) => this.onMempoolSwap(swap), chain);
  }

  /** Fetches pool states from chain and builds the route graph. */
  async loadPools(poolAddresses: Address[]): Promise<void> {
    const pairs = await Promise.all(
      poolAddresses.map((addr) => UniswapV2Pair.fromChain(addr, this.chainClient)),
    );
    for (const pair of pairs) {
      this.pools.set(pair.address.lower, pair);
    }
    this.router = new RouteFinder([...this.pools.values()]);
  }

  /** Re-fetches reserves for a single pool and patches the route graph in-place. */
  async refreshPool(address: Address): Promise<void> {
    const pair = await UniswapV2Pair.fromChain(address, this.chainClient);
    this.pools.set(pair.address.lower, pair);
    if (this.router) {
      this.router.updatePool(pair);
    }
  }

  /** Subscribes to on-chain Sync events per pool via WebSocket — reserves patched in-place, no polling. */
  async startPoolMonitor(poolAddresses: Address[]): Promise<void> {
    if (this.poolMonitorRunning) throw new QuoteError('Pool monitor is already running');
    if (poolAddresses.length === 0) throw new QuoteError('Pool monitor needs at least one pool');

    await this.refreshPools(poolAddresses);
    this.poolMonitorRunning = true;

    const wsClient = createPublicClient({
      chain: this.chain,
      transport: webSocket(this.wsUrl, {
        onError: (err) =>
          log.warn(`Pool monitor WS error: ${err instanceof Error ? err.message : String(err)}`),
      }),
    });

    for (const addr of poolAddresses) {
      const unwatch = wsClient.watchContractEvent({
        address: addr.value as `0x${string}`,
        abi: SYNC_ABI,
        eventName: 'Sync',
        onLogs: (logs) => {
          for (const logEntry of logs) {
            const existing = this.pools.get(addr.lower);
            const r0 = logEntry.args.reserve0;
            const r1 = logEntry.args.reserve1;
            if (existing && r0 !== undefined && r1 !== undefined) {
              const updated = new UniswapV2Pair(
                existing.address,
                existing.token0,
                existing.token1,
                r0,
                r1,
                existing.feeBps,
              );
              this.pools.set(addr.lower, updated);
              if (this.router) this.router.updatePool(updated);

              const count = (this.syncCounters.get(addr.lower) ?? 0) + 1;
              this.syncCounters.set(addr.lower, count);
              const d0 =
                existing.reserve0 > 0n
                  ? Number(r0 - existing.reserve0) / 10 ** existing.token0.decimals
                  : 0;
              const d1 =
                existing.reserve1 > 0n
                  ? Number(r1 - existing.reserve1) / 10 ** existing.token1.decimals
                  : 0;
              const price =
                Number(r1) /
                10 ** existing.token1.decimals /
                (Number(r0) / 10 ** existing.token0.decimals);
              log.info(
                `SYNC #${count} pool=${addr.value.slice(0, 10)} ` +
                  `tx=${logEntry.transactionHash ?? 'pending'} ` +
                  `price=$${price.toFixed(2)} ` +
                  `d${existing.token0.symbol}=${d0 >= 0 ? '+' : ''}${d0.toFixed(6)} ` +
                  `d${existing.token1.symbol}=${d1 >= 0 ? '+' : ''}${d1.toFixed(2)}`,
              );
            }
          }
        },
      });
      this.syncUnwatchers.push(unwatch);
    }
    log.info(
      `Pool sync subscribed via WebSocket for ${poolAddresses.map((a) => a.value).join(', ')}`,
    );
  }

  /** Stops the WebSocket pool sync subscription. */
  stopPoolMonitor(): void {
    for (const unwatch of this.syncUnwatchers) unwatch();
    this.syncUnwatchers = [];
    this.poolMonitorRunning = false;
  }

  /** Finds the best route, simulates it, and returns a Quote; throws QuoteError on failure. */
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

  /** Pool math only — no fork simulation. Use for signal generation where latency matters. */
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

  private async refreshPools(poolAddresses: readonly Address[]): Promise<void> {
    const pairs = await Promise.all(
      poolAddresses.map((address) => UniswapV2Pair.fromChain(address, this.chainClient)),
    );
    for (const pair of pairs) {
      this.pools.set(pair.address.lower, pair);
      if (this.router) {
        this.router.updatePool(pair);
      }
    }
  }

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
      void this.refreshPool(addr).catch((e: unknown) => {
        log.error(
          `Failed to refresh pool ${addr.value}: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    }
  }
}
