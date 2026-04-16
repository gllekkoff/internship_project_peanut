# Internship project - Arbitrage

TypeScript infrastructure for Ethereum DeFi arbitrage - wallet management, on-chain queries, AMM pricing, CEX connectivity, inventory management, and end-to-end arb opportunity detection.

---

## Architecture

The project is split into three subsystems that feed into a top-level integration layer.

**Chain** is the foundation - `ChainClient` (viem) handles all Ethereum RPC calls with failover and retry. `WalletManager` and `TransactionService` sit on top for signing and submission.

**Pricing** builds on chain. `UniswapV2Pair` loads pool state from chain, `RouteFinder` finds the best multi-hop path, `ForkSimulator` validates the math against real Solidity on an Anvil fork, and `MempoolMonitor` keeps pool state fresh by watching pending swaps over WebSocket. `PricingEngine` orchestrates all of this into a single `getQuote()` call.

**Exchange** is independent of chain. `ExchangeClient` connects to Binance via ccxt and fetches live order books and balances. `OrderBookAnalyzer` simulates fills, measures depth, and computes slippage from a snapshot.

**Inventory** tracks the state of our own positions. `InventoryTracker` holds balances across venues and validates arb legs before execution. `RebalancePlanner` generates transfer plans when positions drift. `PnLEngine` records completed trades and produces aggregate reports.

**ArbChecker** is the integration layer. It pulls a DEX price from `PricingEngine`, a CEX order book from `ExchangeClient`, checks inventory via `InventoryTracker`, and returns a full opportunity assessment - gap, costs, net PnL, and whether the trade is executable. It never places orders.

All monetary values across all subsystems use `bigint` scaled by `PRICE_SCALE = 1e8`.

---

## Modules

### `core`

Shared primitives used across all modules.

Defines `Address`, `Token`, and `TokenAmount` types. `AppError` is the base for all domain errors and strips private keys from messages. `WalletManager` handles key loading and signing.

---

### `chain`

Ethereum RPC layer.

`ChainClient` wraps viem with multi-endpoint failover and exponential backoff retry. `TransactionService` builds and submits EIP-1559 transactions. `GasCalculator` computes fees from recent blocks. `analyzer/` is a CLI that decodes calldata and logs token transfers for any tx hash.

---

### `configs`

Central environment config.

Validates all env vars at startup and throws immediately on missing required ones. Config is grouped by domain: `config.chain.*` for RPC and keys, `config.binance.*` for exchange credentials.

---

### `pricing/uniswap-v2`

AMM math and on-chain pair state.

`UniswapV2Pair.fromChain()` loads live reserves and token metadata from chain. `UniswapV2Calculator` implements pure bigint math for `getAmountOut`, spot price, and price impact - matching Solidity integer arithmetic exactly.

---

### `pricing/routing`

Multi-hop route discovery.

`RouteFinder` runs DFS over a pool graph to find all paths between two tokens. Routes are ranked by gas-adjusted net output so cheaper multi-hop routes beat higher-output ones when gas dominates.

---

### `pricing/mempool`

Live mempool monitoring over WebSocket.

Subscribes to `eth_subscribe("newPendingTransactions")`, fetches each transaction, and decodes Uniswap V2 router calls into `ParsedSwap` events with normalized token and amount fields.

---

### `pricing/forkSimulator`

Simulation against a local Anvil fork.

Runs swaps as `eth_call` against real Solidity bytecode - no transaction is broadcast and no state is mutated. Used to validate that our TypeScript AMM math matches the on-chain router output.

---

### `pricing/engine`

Top-level pricing orchestrator.

`getQuote()` finds the best route, simulates it on the fork, and returns a `Quote` with an `isValid` flag (simulation within 0.1% of calculated output). Refreshes affected pools automatically when the mempool detects a relevant swap.

---

### `exchange/cexClient`

Binance CEX client built on ccxt.

All prices and quantities are `bigint` scaled by `PRICE_SCALE = 1e8`. Includes a sliding-window rate limiter tracking Binance request weights (limit 1100/min). Maps ccxt errors to typed domain errors. Methods: `fetchOrderBook`, `fetchBalance`, `createLimitOrder`, `createLimitIocOrder`, `cancelOrder`, `getTradingFees`.

---

### `exchange/orderBook`

Order book analysis on a single snapshot.

`walkTheBook(side, qty)` simulates fills across price levels and returns avg fill price and slippage in bps. `depthAtBps(side, bps)` returns total liquidity within a price range. `imbalance()` returns bid/ask volume ratio in `[-1.0, +1.0]`. `effectiveSpread(qty)` measures the real round-trip cost at a given trade size.

---

### `inventory/tracker`

Single source of truth for positions across venues.

Holds live balances for Binance and wallet. `canExecute()` checks both legs of an arb before execution. `skew()` computes deviation from the ideal even split and flags assets that need rebalancing (≥ 30% off). `recordTrade()` applies buy/sell/fee adjustments to internal balances.

---

### `inventory/rebalancer`

Transfer plan generation to restore target ratios.

Greedily pairs the largest surplus venue with the largest deficit. Enforces min operating balances per venue (0.5 ETH, 500 USDT) and min withdrawal sizes per asset (0.01 ETH, 10 USDT). `estimateCost()` returns wall-clock time assuming all transfers run in parallel.

---

### `inventory/pnl`

Per-trade and aggregate PnL tracking.

`ArbRecord` holds a buy leg, sell leg, and gas cost with computed `grossPnl`, `netPnl`, and `netPnlBps` in bigint. `PnLEngine` records trades and produces summaries with win rate, avg bps, and a Sharpe estimate. Supports CSV export.

---

### `integration/arbChecker`

End-to-end arb opportunity detection.

Wires `PricingEngine`, `ExchangeClient`, `InventoryTracker`, and `PnLEngine` together. `check(pair)` fetches a live DEX price and CEX order book, calculates the gross gap, estimates all costs (DEX fee, price impact, CEX fee, slippage, gas), runs inventory pre-flight, and returns a full result with direction and executable verdict. Read-only - no orders are placed.

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Install Foundry (required for fork simulation)

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
```

### 3. Configure environment

```bash
cp .env.example .env
```

```env
MAINNET_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY   # required
PRIVATE_KEY=0x...                                                 # required
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY    # optional
BINANCE_TESTNET_API_KEY=...                                       # optional - exchange features
BINANCE_TESTNET_SECRET=...                                        # optional - exchange features
PORT=3000                                                         # optional, default 3000
```

---

## Commands

| Command | Description |
|---------|-------------|
| `npm test` | Run all unit + integration tests |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run lint` | Lint `src/` |
| `npm run format` | Format `src/` with Prettier |

---

## Scripts

### Order book analysis (live Binance testnet)

```bash
npx tsx src/scripts/orderBook.script.ts ETH/USDT --depth 20
```

Fetches live order book and prints spread, depth at 10 bps, imbalance, walk-the-book for 2 and 10 ETH, and effective spread.

### Arb checker (live mainnet + Binance testnet)

```bash
npx tsx src/scripts/arb_checker.script.ts --pair ETH/USDT --size 2.0
```

Loads the Uniswap V2 USDC/WETH pool from mainnet, fetches a live Binance order book, and prints a full opportunity assessment - gap, cost breakdown, net PnL estimate, inventory check, and verdict.

### Place and cancel a test order

```bash
npx tsx src/scripts/order.script.ts ETH/USDT
```

Places a limit buy 10% below market (won't fill), shows the open order, then cancels it.

### Portfolio snapshot

```bash
npx tsx src/scripts/portfolio.script.ts
```

Fetches real Binance balances + on-chain wallet ETH balance and prints a cross-venue snapshot with skew report.

### PnL report

```bash
npx tsx src/scripts/pnl.script.ts --summary
```

Runs 47 synthetic arb trades and prints win rate, total PnL, Sharpe estimate, and the 4 most recent trades.

### Rebalancer

```bash
npx tsx src/scripts/rebalancer.script.ts --check
npx tsx src/scripts/rebalancer.script.ts --plan ETH
```

Shows skew report and generates a transfer plan with fee accounting.

### Pricing engine integration

```bash
npx tsx src/scripts/pricing.script.ts
FORK_URL=http://127.0.0.1:8545 npx tsx src/scripts/pricing.script.ts
```

Loads live Uniswap V2 pools, prints pool snapshots and ETH price derived from reserves. With `FORK_URL` set, calls `PricingEngine.getQuote()` and prints the simulation result.

### AMM math vs on-chain router

```bash
./src/scripts/start_fork.sh
npx tsx src/scripts/verify_amm.ts
```

### Mempool monitoring

```bash
npx tsx src/scripts/verify_mempool.ts
```

---

## Tests

To run tests across all modules:

```bash
npm test
```
