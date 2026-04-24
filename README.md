# Internship project - Arbitrage

TypeScript infrastructure for Ethereum DeFi arbitrage — wallet management, on-chain queries, AMM pricing, CEX connectivity, inventory management, signal generation, scoring, and end-to-end execution.

---

## Architecture

The project is built in layers that feed into a live arb bot.

**Chain** is the foundation — `ChainClient` (viem) handles all Ethereum RPC calls with failover and retry. `WalletManager` and `TransactionService` sit on top for signing and submission.

**Pricing** builds on chain. `UniswapV2Pair` loads pool state from chain, `RouteFinder` finds the best multi-hop path, `ForkSimulator` validates the math against real Solidity on an Anvil fork, and `MempoolMonitor` keeps pool state fresh by watching pending swaps over WebSocket. `PricingEngine` orchestrates all of this — `getQuote()` for full fork-validated pricing, `getAmmQuote()` for fast pool-math-only pricing used during signal generation.

**Exchange** is independent of chain. `ExchangeClient` connects to Binance via ccxt and fetches live order books and balances. `OrderBookAnalyzer` simulates fills, measures depth, and computes slippage from a snapshot.

**Inventory** tracks the state of our own positions. `InventoryTracker` holds balances across venues and validates arb legs before execution. `RebalancePlanner` generates transfer plans when positions drift. `PnLEngine` records completed trades and produces aggregate reports.

**Strategy** is where signals are generated and ranked. `SignalGenerator` compares live CEX and DEX prices, computes net PnL after live gas costs and fees, and emits a typed `Signal`. `SignalScorer` ranks signals 0–100 across spread, inventory health, and trade history, with time-decay applied as the signal ages.

**Executor** turns a signal into real orders. `Executor` runs pre-flight checks, executes both legs (CEX-first), handles partial fills, unwinds on failure, and records the result back to `InventoryTracker`.

**ArbBot** is the top-level entry point that wires all layers together into a polling loop.

All monetary values across all subsystems use `bigint` scaled by `PRICE_SCALE = 1e8`.

---

## Modules

### `core`

Shared primitives used across all modules.

Defines `Address`, `Token`, and `TokenAmount` types. `AppError` is the base for all domain errors — sanitises private keys from messages automatically. `WalletManager` handles key loading and signing. `SerializerService` handles JSON serialisation of bigint values.

---

### `chain`

Ethereum RPC layer.

`ChainClient` wraps viem with multi-endpoint failover and exponential backoff retry. Exposes `getGasPrice()` which samples the last 5 blocks and returns priority fees at the 10th/50th/90th percentiles. `TransactionService` builds and submits EIP-1559 transactions. `GasPrice` holds fee data and computes `maxFeePerGas` with a configurable base-fee buffer. `analyzer/` is a CLI that decodes calldata and logs token transfers for any tx hash.

---

### `configs`

Central environment config.

Validates all env vars at startup and throws immediately on missing required ones. Config is grouped by domain: `config.chain.*` for RPC and keys, `config.binance.*` for exchange credentials.

---

### `pricing/uniswap-v2`

AMM math and on-chain pair state.

`UniswapV2Pair.fromChain()` loads live reserves and token metadata from chain. `UniswapV2Calculator` implements pure bigint constant-product math for `getAmountOut`, spot price, and price impact — matching Solidity integer arithmetic exactly.

---

### `pricing/routing`

Multi-hop route discovery.

`RouteFinder` runs DFS over a pool graph to find all paths between two tokens. Routes are ranked by gas-adjusted net output so cheaper multi-hop routes beat higher-output ones when gas dominates.

---

### `pricing/mempool`

Live mempool monitoring over WebSocket.

Subscribes to `eth_subscribe("newPendingTransactions")`, fetches each transaction, and decodes Uniswap V2 router calls into `ParsedSwap` events with normalised token and amount fields.

---

### `pricing/forkSimulator`

Simulation against a local Anvil fork.

Runs swaps as `eth_call` against real Solidity bytecode — no transaction is broadcast and no state is mutated. Used to validate that TypeScript AMM math matches the on-chain router output exactly.

---

### `pricing/engine`

Top-level pricing orchestrator.

Two entry points:
- `getQuote()` — finds the best route, simulates it on the fork via `ForkSimulator`, returns a `Quote` with expected and simulated output. Slow but accurate. Used for final execution validation.
- `getAmmQuote()` — pool math only, no fork call. Returns expected output in microseconds. Used during signal generation where latency matters.

`startMonitor()` subscribes to the mempool and auto-refreshes affected pool reserves when a relevant swap is detected, keeping AMM quotes fresh between ticks.

---

### `exchange/cexClient`

Binance CEX client built on ccxt.

All prices and quantities are `bigint` scaled by `PRICE_SCALE = 1e8`. Includes a sliding-window rate limiter tracking Binance request weights (limit 1100/min with safety buffer). Maps ccxt errors to typed domain errors. Methods: `fetchOrderBook`, `fetchBalance`, `createLimitIocOrder`, `createMarketOrder`, `cancelOrder`, `getTradingFees`, `fetchWithdrawalFees` (returns empty on testnet sandbox where the endpoint is unavailable).

---

### `exchange/orderBook`

Order book analysis on a single snapshot.

`walkTheBook(side, qty)` simulates fills across price levels and returns avg fill price and slippage in bps. `depthAtBps(side, bps)` returns total liquidity within a price range. `imbalance()` returns bid/ask volume ratio in `[-1.0, +1.0]`. `effectiveSpread(qty)` measures the real round-trip cost at a given trade size.

---

### `inventory/tracker`

Single source of truth for positions across venues.

Holds live balances for Binance and wallet. `updateFromCex()` and `updateFromWallet()` replace the stored snapshot entirely on each sync. `canExecute()` checks both legs of an arb before execution. `recordTrade()` applies buy/sell/fee deltas to internal balances after a completed execution. `skew()` computes each asset's deviation from the ideal even split across venues.

---

### `inventory/rebalancer`

Transfer plan generation to restore target ratios.

Greedily pairs the largest surplus venue with the largest deficit. Enforces min operating balances per venue (0.5 ETH, 500 USDT) and min withdrawal sizes per asset. `estimateCost()` returns wall-clock time assuming all transfers run in parallel. Threshold and fees come from `VenueProfile` — not hardcoded.

---

### `inventory/pnl`

Per-trade and aggregate PnL tracking.

`ArbRecord` holds a buy leg, sell leg, and gas cost with computed `grossPnl`, `netPnl`, and `netPnlBps` in bigint. `PnLEngine` records trades and produces summaries with win rate, avg bps, avg per trade, and a Sharpe estimate. Supports CSV export.

---

### `venues`

Per-exchange configuration profiles.

`VenueProfile` is a plain object holding all venue-specific parameters: rate limits and endpoint weights, withdrawal fees and minimums per asset, min operating balances, rebalance threshold, and combined fee rate in bps. `BINANCE_PROFILE` ships with static defaults. `VenueHydrator.hydrate()` fetches live withdrawal fees at startup and overwrites the mutable entries — falls back to static defaults on testnet sandboxes where the endpoint is unavailable. `profile.hydrated` is set to `true` regardless so the bot can assert readiness.

---

### `strategy/fee.calculator`

Pure fee math — no side effects.

`totalFee(tradeValue, liveGasCost?)` returns combined CEX taker + DEX swap fees plus gas cost. Accepts an optional live gas cost (bigint, scaled) that overrides the static `gasCost` set at construction — used when `SignalGenerator` has fetched a real gas price from chain.

---

### `strategy/signal.generator`

Generates arb signals from live price data.

Each tick: fetches the CEX order book, fetches DEX prices (real AMM via `PricingEngine.getAmmQuote()` or random stub in no-DEX mode), fetches the live gas price from `ChainClient`, and computes both spread directions. Emits a `Signal` when net PnL clears `minProfit` after all fees. Signals carry `inventoryOk` and `withinLimits` flags set at generation time. Enforces a per-pair cooldown between signals.

In no-DEX mode the DEX price is a random stub: 0–150 bps above mid for the sell side, 0–80 bps below mid for the buy side — enough to generate varied scores for demo/testing.

---

### `strategy/scorer`

Multi-factor signal ranking.

`score(signal, checks)` computes a composite 0–100 score:

| Factor | Weight | Source |
|--------|--------|--------|
| Spread | 40% | Linear: minSpreadBps → 0, excellentSpreadBps → 100 |
| Liquidity | 20% | Fixed 80 (placeholder — no depth feed yet) |
| Inventory | 20% | 60 normally, 20 when rebalance is flagged |
| History | 20% | Win rate of last 20 executions for the pair (50 when < 3 data points) |

`applyDecay(signal, score?)` applies a linear decay of up to 50% as the signal ages toward its TTL. `recordResult(pair, success)` feeds the history component after each execution.

---

### `executor/engine`

Two-legged arb execution with circuit breaking and replay protection.

Pre-flight checks before any order:
1. Circuit breaker — trips after 3 failures within 60 seconds, auto-resets after cooldown
2. Replay protection — rejects duplicate signal IDs within their TTL window
3. `signal.isValid()` — checks expiry, `inventoryOk`, `withinLimits`, positive net PnL
4. `inventory.canExecute()` — live pre-flight on both legs

Execution (CEX-first, Flashbots disabled):
- **Leg 1 (CEX)** — limit IOC order with 0.1% price buffer, 5s timeout, 80% minimum fill ratio
- **Leg 2 (DEX)** — simulated fill in dry-run; real on-chain execution not yet wired
- **Unwind** — if Leg 2 fails, a market order reverses the Leg 1 CEX position

On success: `recordTrades()` applies fill deltas to `InventoryTracker` for both venues. `calculatePnl()` computes actual realised PnL from fill prices minus the combined fee rate.

---

### `executor/recovery`

Windowed circuit breaker and replay protection.

`CircuitBreaker` counts failures within a rolling time window — not a simple counter. Trips when `failureThreshold` failures occur within `windowMs`, auto-resets after `cooldownMs`. `ReplayProtection` stores a TTL-keyed set of executed signal IDs and rejects any signal seen within its TTL.

---

### `integration/arbChecker`

Stand-alone arb opportunity scanner. Read-only — no orders placed.

Wires `PricingEngine`, `ExchangeClient`, and `InventoryTracker` together. `check(pair)` fetches a live DEX price and CEX order book, calculates the gross gap, estimates all costs (DEX fee, price impact, CEX fee, slippage, gas), runs inventory pre-flight, and returns a full result with direction, cost breakdown, and executable verdict. Used for analysis and reporting — separate from the bot pipeline.

---

## Arb Bot

`src/scripts/arb_bot.script.ts` is the main entry point. It runs a polling loop that generates, scores, and executes arb signals across ETH/USDT.

### Pipeline

```
startup
  connect to Binance → verify API keys
  fetch real CEX balances → InventoryTracker
  seed wallet with dummy balances (no-DEX/dry-run only)
  VenueHydrator → live withdrawal fees (static defaults on testnet)
  load Uniswap V2 pool from chain + start mempool monitor (full mode only)

tick (every 1s)
  syncBalances        → refresh CEX balances
  SignalGenerator     → CEX order book + DEX price + live gas cost → Signal or null
  SignalScorer        → composite 0–100 score + time decay
  score < threshold   → skip
  Executor            → pre-flight checks → CEX limit IOC → DEX sim → recordTrades
  PnLEngine           → record ArbRecord → update session summary
```

### Running

```bash
# Full simulation — no real orders, random DEX prices, real gas from mainnet RPC
npx tsx src/scripts/arb_bot.script.ts --dry-run --no-dex

# Real CEX orders on testnet, random DEX prices (no mainnet fork needed)
npx tsx src/scripts/arb_bot.script.ts --no-dex

# Real CEX orders + real Uniswap V2 AMM prices (requires Anvil fork of mainnet)
npx tsx src/scripts/arb_bot.script.ts
```

### Flags

| Flag | Effect |
|------|--------|
| `--dry-run` | Simulates both CEX and DEX legs — no real orders sent |
| `--no-dex` | Skips Uniswap pool loading, uses random stub for DEX prices |

| Mode | CEX orders | DEX prices | Gas |
|------|-----------|-----------|-----|
| `--dry-run --no-dex` | simulated | random stub | live mainnet |
| `--no-dex` | real testnet | random stub | live mainnet |
| `--dry-run` | simulated | real AMM | live mainnet |
| _(none)_ | real | real AMM | live mainnet |

### Inventory in dry-run / no-DEX mode

When `--no-dex` or `--dry-run` is set, the wallet venue is seeded with 100 ETH + 100k USDT so that inventory pre-flight checks pass. The CEX venue always uses real Binance balances fetched each tick. The wallet is never synced from chain in these modes since there is no real on-chain execution.

### Output example

```
2026-04-24 08:12:41 INFO  Signal [ETHUSDTa3f7b2c1] ETH/USDT 0.1 ETH — buy_cex_sell_dex
2026-04-24 08:12:41 INFO    prices : cex=$2308.8200  dex=$2340.7100  spread=138.0bps
2026-04-24 08:12:41 INFO    pnl    : gross=$3.19  fees=$0.93  net=$2.26
2026-04-24 08:12:41 INFO    score  : 72.0 (raw=72.0, threshold=60)
2026-04-24 08:12:41 INFO    → Executing 0.1 ETH
2026-04-24 08:12:42 INFO  SUCCESS | actual net=$2.11 | session: trades=1 pnl=$2.11 win=100%
```

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Install Foundry (required for fork simulation only)

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
BINANCE_TESTNET_API_KEY=...                                       # required for CEX features
BINANCE_TESTNET_SECRET=...                                        # required for CEX features
PORT=3000                                                         # optional, default 3000
```

---

## Commands

| Command | Description |
|---------|-------------|
| `npm test` | Run all tests |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run lint` | Lint `src/` |
| `npm run format` | Format `src/` with Prettier |

---

## Scripts

### Arb bot

```bash
npx tsx src/scripts/arb_bot.script.ts --dry-run --no-dex
```

See [Arb Bot](#arb-bot) section above.

### Order book analysis

```bash
npx tsx src/scripts/orderBook.script.ts ETH/USDT --depth 20
```

Fetches live order book and prints spread, depth at 10 bps, imbalance, walk-the-book for 2 and 10 ETH, and effective spread.

### Arb checker (analysis only)

```bash
npx tsx src/scripts/arb_checker.script.ts --pair ETH/USDT --size 2.0
```

Loads the Uniswap V2 USDC/WETH pool from mainnet, fetches a live Binance order book, and prints a full opportunity assessment — gap, cost breakdown, net PnL estimate, inventory check, and verdict. Does not place orders.

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

Runs synthetic arb trades and prints win rate, total PnL, Sharpe estimate, and recent trades.

### Rebalancer

```bash
npx tsx src/scripts/rebalancer.script.ts --check
npx tsx src/scripts/rebalancer.script.ts --plan ETH
```

Shows skew report and generates a transfer plan with fee accounting.

### Pricing engine

```bash
npx tsx src/scripts/pricing.script.ts
FORK_URL=http://127.0.0.1:8545 npx tsx src/scripts/pricing.script.ts
```

Loads live Uniswap V2 pools and prints pool snapshots and ETH price derived from reserves. With `FORK_URL` set, also runs `PricingEngine.getQuote()` and prints the simulation result.

### AMM math verification

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

```bash
npm test
```

330 tests across all modules — chain, pricing, exchange, inventory, strategy, and executor.
