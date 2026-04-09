import { describe, expect, it } from 'vitest';
import { Address, Token } from '@/core/core.types';
import { UniswapV2Pair } from '@/pricing/uniswap-v2/uniswap-v2.service';
import { Route, RouteFinder } from '@/pricing/routing/routing.service';
import { InvalidRouteError, NoRouteFoundError } from '@/pricing/routing/routing.errors';

// ---------------------------------------------------------------------------
// Token fixtures
// Canonical Uniswap ordering by address hex: DAI < SHIB < USDC < WETH
// ---------------------------------------------------------------------------

const WETH = new Token(new Address('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'), 'WETH', 18);
const USDC = new Token(new Address('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'), 'USDC', 6);
const DAI = new Token(new Address('0x6B175474E89094C44Da98b954EedeAC495271d0F'), 'DAI', 18);
const SHIB = new Token(new Address('0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE'), 'SHIB', 18);

// Isolated token with no pools — used in the "no route" test.
const LINK = new Token(new Address('0x514910771AF9Ca656af840dff83E8264EcF986CA'), 'LINK', 18);

// ---------------------------------------------------------------------------
// Pool helpers
// ---------------------------------------------------------------------------

/**
 * 1000 WETH / 2 000 000 USDC — standard "2000 USDC per WETH" deep pool.
 * token0 = USDC, token1 = WETH  (USDC address < WETH address)
 */
const makeWethUsdcPool = () =>
  new UniswapV2Pair(
    new Address('0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc'),
    USDC,
    WETH,
    2_000_000n * 10n ** 6n,
    1_000n * 10n ** 18n,
  );

/**
 * 1000 WETH / 2 000 000 DAI — same price, different output token.
 * token0 = DAI, token1 = WETH
 */
const makeWethDaiPool = () =>
  new UniswapV2Pair(
    new Address('0xA478c2975Ab1Ea89e8196811F51A7B7Ade33eB11'),
    DAI,
    WETH,
    2_000_000n * 10n ** 18n,
    1_000n * 10n ** 18n,
  );

/**
 * 1 000 000 DAI / 1 000 000 USDC — roughly 1:1 stablecoin pool.
 * token0 = DAI, token1 = USDC
 */
const makeDaiUsdcPool = () =>
  new UniswapV2Pair(
    new Address('0xAE461cA67B15dc8dc81CE7615e0320dA1A9aB8D5'),
    DAI,
    USDC,
    1_000_000n * 10n ** 18n,
    1_000_000n * 10n ** 6n,
  );

/**
 * Thin SHIB/USDC direct pool — intentionally poor rate.
 * 100 000 000 SHIB / 100 USDC → ~0.000001 USDC per SHIB
 * token0 = SHIB, token1 = USDC
 */
const makeShibUsdcThinPool = () =>
  new UniswapV2Pair(
    new Address('0x811beEd0119b4AfCE20D2583EB608C6F7AF1954f'),
    SHIB,
    USDC,
    100_000_000n * 10n ** 18n,
    100n * 10n ** 6n,
  );

/**
 * Deep SHIB/WETH pool.
 * 1 000 000 000 SHIB / 1000 WETH → ~0.000001 WETH per SHIB
 * token0 = SHIB, token1 = WETH
 */
const makeShibWethPool = () =>
  new UniswapV2Pair(
    new Address('0x22F9dCF4647084d6C31b2765F6910cd85C178C18'),
    SHIB,
    WETH,
    1_000_000_000n * 10n ** 18n,
    1_000n * 10n ** 18n,
  );

// ---------------------------------------------------------------------------
// 1. Direct vs multi-hop (multi-hop wins)
// ---------------------------------------------------------------------------

describe('test_direct_vs_multihop', () => {
  /**
   * Selling 1 000 000 SHIB:
   *   direct  SHIB→USDC (thin pool): ~0.98 USDC
   *   2-hop   SHIB→WETH→USDC (deep pools): ~1990 USDC
   * Multi-hop is overwhelmingly better at low gas prices.
   */
  it('multi-hop route gives more USDC than direct thin pool', () => {
    const finder = new RouteFinder([makeWethUsdcPool(), makeShibWethPool(), makeShibUsdcThinPool()]);

    const amountIn = 1_000_000n * 10n ** 18n; // 1 M SHIB
    // 1 ETH = ~2000 USDC → ethPriceInOutputToken = 2000 * 1e6
    const ethPrice = 2_000n * 10n ** 6n;

    const [bestRoute, bestNet] = finder.findBestRoute(SHIB, USDC, amountIn, 1n, 3, ethPrice);

    expect(bestRoute.numHops).toBe(2);
    expect(bestRoute.toString()).toBe('SHIB → WETH → USDC');

    // Verify multi-hop gross output dwarfs the direct route
    const allRoutes = finder.findAllRoutes(SHIB, USDC);
    const directRoute = allRoutes.find((r) => r.numHops === 1)!;
    const multiRoute = allRoutes.find((r) => r.numHops === 2)!;

    expect(multiRoute.getOutput(amountIn)).toBeGreaterThan(directRoute.getOutput(amountIn) * 100n);
    expect(bestNet).toBeGreaterThan(0n);
  });

  it('compareRoutes returns multi-hop first when it wins', () => {
    const finder = new RouteFinder([makeWethUsdcPool(), makeShibWethPool(), makeShibUsdcThinPool()]);
    const amountIn = 1_000_000n * 10n ** 18n;
    const ethPrice = 2_000n * 10n ** 6n;

    const comparisons = finder.compareRoutes(SHIB, USDC, amountIn, 1n, 3, ethPrice);

    expect(comparisons[0]!.route.numHops).toBe(2);
    // Sorted descending by net output
    expect(comparisons[0]!.netOutput).toBeGreaterThanOrEqual(comparisons[1]!.netOutput);
  });
});

// ---------------------------------------------------------------------------
// 2. High gas makes direct route win
// ---------------------------------------------------------------------------

describe('test_gas_makes_direct_better', () => {
  /**
   * Selling 1 WETH:
   *   direct  WETH→USDC (slightly thin pool): ~1972 USDC gross
   *   2-hop   WETH→DAI→USDC (deep pools):   ~1984 USDC gross  (+12 USDC)
   *
   * Extra gas for the 2nd hop = 100 000 gas units.
   * At 100 gwei + ETH=2000 USDC: extra gas ≈ 20 USDC  →  direct wins.
   * At   1 gwei + ETH=2000 USDC: extra gas ≈  0.2 USDC →  multi wins.
   */

  // WETH/USDC pool with slightly worse rate than the DAI path.
  const makeWethUsdcSlightlyThinPool = () =>
    new UniswapV2Pair(
      new Address('0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc'),
      USDC,
      WETH,
      1_980_000n * 10n ** 6n, // 1 980 000 USDC / 1000 WETH → 1980 USDC/WETH spot
      1_000n * 10n ** 18n,
    );

  const amountIn = 1n * 10n ** 18n; // 1 WETH
  const ethPrice = 2_000n * 10n ** 6n; // 2000 USDC per ETH

  it('at low gas multi-hop wins on net output', () => {
    const finder = new RouteFinder([makeWethUsdcSlightlyThinPool(), makeWethDaiPool(), makeDaiUsdcPool()]);
    const [bestRoute] = finder.findBestRoute(WETH, USDC, amountIn, 1n, 3, ethPrice);
    expect(bestRoute.numHops).toBe(2);
  });

  it('at high gas direct wins on net output', () => {
    const finder = new RouteFinder([makeWethUsdcSlightlyThinPool(), makeWethDaiPool(), makeDaiUsdcPool()]);
    const [bestRoute] = finder.findBestRoute(WETH, USDC, amountIn, 100n, 3, ethPrice);
    expect(bestRoute.numHops).toBe(1);
  });

  it('compareRoutes respects gas: direct is first at high gas', () => {
    const finder = new RouteFinder([makeWethUsdcSlightlyThinPool(), makeWethDaiPool(), makeDaiUsdcPool()]);
    const comparisons = finder.compareRoutes(WETH, USDC, amountIn, 100n, 3, ethPrice);
    expect(comparisons[0]!.route.numHops).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. No route exists
// ---------------------------------------------------------------------------

describe('test_no_route_exists', () => {
  it('findAllRoutes returns empty array for disconnected tokens', () => {
    const finder = new RouteFinder([makeWethUsdcPool()]);
    const routes = finder.findAllRoutes(LINK, DAI);
    expect(routes).toHaveLength(0);
  });

  it('findBestRoute throws NoRouteFoundError for disconnected tokens', () => {
    const finder = new RouteFinder([makeWethUsdcPool()]);
    expect(() => finder.findBestRoute(LINK, DAI, 1n * 10n ** 18n, 1n)).toThrow(NoRouteFoundError);
  });

  it('findAllRoutes returns empty for token with no pools at all', () => {
    const finder = new RouteFinder([makeWethUsdcPool(), makeWethDaiPool()]);
    const routes = finder.findAllRoutes(SHIB, USDC);
    expect(routes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Route simulation equals sequential manual swaps
// ---------------------------------------------------------------------------

describe('test_route_output_matches_sequential_swaps', () => {
  it('2-hop route output matches manual pool-by-pool computation', () => {
    const wethUsdc = makeWethUsdcPool();
    const wethDai = makeWethDaiPool();
    const daiUsdc = makeDaiUsdcPool();

    const finder = new RouteFinder([wethUsdc, wethDai, daiUsdc]);
    const routes = finder.findAllRoutes(WETH, USDC, 3);
    const twoHop = routes.find((r) => r.numHops === 2 && r.toString() === 'WETH → DAI → USDC')!;
    expect(twoHop).toBeDefined();

    const amountIn = 1n * 10n ** 18n;

    // Manual sequential swaps
    const daiOut = wethDai.getAmountOut(amountIn, WETH);
    const usdcOut = daiUsdc.getAmountOut(daiOut, DAI);

    expect(twoHop.getOutput(amountIn)).toBe(usdcOut);
  });

  it('getIntermediateAmounts first entry is amountIn, last is getOutput', () => {
    const finder = new RouteFinder([makeWethDaiPool(), makeDaiUsdcPool()]);
    const [route] = finder.findAllRoutes(WETH, USDC, 2);
    const amountIn = 5n * 10n ** 17n; // 0.5 WETH

    const steps = route!.getIntermediateAmounts(amountIn);

    expect(steps).toHaveLength(3); // [input, after_hop1, after_hop2]
    expect(steps[0]).toBe(amountIn);
    expect(steps[steps.length - 1]).toBe(route!.getOutput(amountIn));
  });

  it('3-hop route output matches manual 3-step computation', () => {
    // SHIB → WETH → DAI → USDC  (three hops)
    const shibWeth = makeShibWethPool();
    const wethDai = makeWethDaiPool();
    const daiUsdc = makeDaiUsdcPool();

    const finder = new RouteFinder([shibWeth, wethDai, daiUsdc]);
    const routes = finder.findAllRoutes(SHIB, USDC, 3);
    expect(routes).toHaveLength(1);

    const amountIn = 10_000n * 10n ** 18n; // 10k SHIB

    const step1 = shibWeth.getAmountOut(amountIn, SHIB);
    const step2 = wethDai.getAmountOut(step1, WETH);
    const step3 = daiUsdc.getAmountOut(step2, DAI);

    expect(routes[0]!.getOutput(amountIn)).toBe(step3);
  });
});

// ---------------------------------------------------------------------------
// 5. Route construction & graph
// ---------------------------------------------------------------------------

describe('Route construction', () => {
  it('throws InvalidRouteError when path.length !== pools.length + 1', () => {
    expect(() => new Route([makeWethUsdcPool()], [WETH])).toThrow(InvalidRouteError);
  });

  it('estimateGas: 1 hop = 250k, 2 hops = 350k, 3 hops = 450k', () => {
    const r1 = new Route([makeWethUsdcPool()], [WETH, USDC]);
    const r2 = new Route([makeWethDaiPool(), makeDaiUsdcPool()], [WETH, DAI, USDC]);
    const shibWeth = makeShibWethPool();
    const r3 = new Route([shibWeth, makeWethDaiPool(), makeDaiUsdcPool()], [SHIB, WETH, DAI, USDC]);

    expect(r1.estimateGas()).toBe(250_000n);
    expect(r2.estimateGas()).toBe(350_000n);
    expect(r3.estimateGas()).toBe(450_000n);
  });

  it('toString formats as "A → B → C"', () => {
    const route = new Route([makeWethDaiPool(), makeDaiUsdcPool()], [WETH, DAI, USDC]);
    expect(route.toString()).toBe('WETH → DAI → USDC');
  });
});

describe('RouteFinder graph', () => {
  it('finds 2 routes WETH→USDC: direct and via DAI', () => {
    const finder = new RouteFinder([makeWethUsdcPool(), makeWethDaiPool(), makeDaiUsdcPool()]);
    const routes = finder.findAllRoutes(WETH, USDC, 3);
    expect(routes).toHaveLength(2);
    const hops = routes.map((r) => r.numHops).sort();
    expect(hops).toEqual([1, 2]);
  });

  it('respects maxHops: setting maxHops=1 returns only the direct route', () => {
    const finder = new RouteFinder([makeWethUsdcPool(), makeWethDaiPool(), makeDaiUsdcPool()]);
    const routes = finder.findAllRoutes(WETH, USDC, 1);
    expect(routes).toHaveLength(1);
    expect(routes[0]!.numHops).toBe(1);
  });

  it('does not reuse the same pool twice in one route', () => {
    const finder = new RouteFinder([makeWethUsdcPool(), makeWethDaiPool(), makeDaiUsdcPool()]);
    const routes = finder.findAllRoutes(WETH, USDC, 4);
    for (const route of routes) {
      const poolAddrs = route.pools.map((p) => p.address.lower);
      const unique = new Set(poolAddrs);
      expect(unique.size).toBe(poolAddrs.length);
    }
  });
});
