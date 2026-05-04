# Arbitrage Bot

TypeScript CEX-DEX arbitrage infrastructure on Arbitrum — wallet management, on-chain queries, AMM pricing, Binance connectivity, inventory tracking, signal generation, scoring, safety, and end-to-end execution.

---

## Architecture

The project is built in layers that feed into a live arb bot.

**Chain** is the foundation. `ChainClient` (viem) handles all Ethereum RPC calls with multi-endpoint failover and exponential backoff retry. `WalletManager` and `TransactionBuilder` sit on top for signing and EIP-1559 submission.

**Pricing** builds on chain. `UniswapV2Pair` loads pool state from chain, `RouteFinder` finds the best multi-hop path, `ForkSimulator` validates the math against real Solidity on an Anvil fork, and `MempoolMonitor` watches pending swaps over WebSocket. `PricingEngine` orchestrates all of this — `getQuote()` for fork-validated pricing, `getAmmQuote()` for fast pool-math-only pricing used during signal generation. Sync events keep reserves fresh without polling.

**Exchange** is independent of chain. `ExchangeClient` connects to Binance via ccxt with a sliding-window rate limiter and maps ccxt errors to typed domain errors. `OrderBookAnalyzer` simulates fills, measures depth, and computes slippage from a snapshot.

**Inventory** tracks live positions. `InventoryTracker` holds balances across Binance and wallet. `RebalancePlanner` generates transfer plans when positions drift. `PnLEngine` records completed trades and produces aggregate reports.

**Strategy** is where signals are generated and ranked. `SignalGenerator` compares live CEX order book (VWAP walk) against DEX AMM output at trade size, computes net PnL after live gas costs and fees, and emits a typed `Signal`. `SignalScorer` ranks signals 0–100 across spread, inventory health, and trade history with time-decay.

**Safety** is a hard gate before execution. `RiskManager` enforces daily loss limits, drawdown ceiling, per-trade size limits, and trade frequency. `PreTradeValidator` checks spread sanity and signal freshness. `AbsoluteSafetyCheck` is a hard ceiling independent of the risk manager. `KillSwitch` shuts the bot down immediately via a file flag or Telegram `/stop`.

**Executor** turns a signal into real orders. Runs circuit-breaker and replay-protection pre-flight, executes CEX leg (limit IOC), then DEX leg (on-chain swap), unwinds the CEX position via market order if the DEX leg fails, and records fills back to `InventoryTracker`.

**ArbBot** (`src/integration/arbBot/`) is the top-level service that wires all layers into a WebSocket-driven event loop.

All monetary values use `bigint` scaled by `PRICE_SCALE = 1e8`.

---

## Modules

### `core`
Shared primitives. `Address`, `Token`, `TokenAmount` types. `AppError` base class — sanitises private keys from error messages automatically. `WalletManager` for key loading and signing. `makeLogger` / `logTrade` / `logError` for structured output.

### `chain`
Ethereum RPC layer. `ChainClient` wraps viem with failover and retry. `getGasPrice()` samples the last 5 blocks and returns fees at the 10th/50th/90th percentile. `TransactionBuilder` builds and submits EIP-1559 transactions with configurable gas multipliers.

### `configs`
Central env config. Validates all required vars at startup and throws immediately on missing ones. `RUN_MODE` is the single mode switch — see [Configuration](#configuration).

### `pricing/uniswap-v2`
AMM math and pool state. `UniswapV2Pair.fromChain()` loads live reserves and token metadata. `UniswapV2Calculator` implements pure bigint constant-product math matching Solidity integer arithmetic exactly.

### `pricing/routing`
Multi-hop route discovery. `RouteFinder` runs DFS over a pool graph to find all paths between two tokens. Routes are ranked by gas-adjusted net output.

### `pricing/mempool`
Live mempool monitoring over WebSocket. Subscribes to `eth_subscribe("newPendingTransactions")`, fetches each transaction, and decodes Uniswap V2 router calls into `ParsedSwap` events.

### `pricing/forkSimulator`
Simulation against a local Anvil fork. Runs swaps as `eth_call` against real Solidity bytecode — no transaction broadcast, no state mutation.

### `pricing/engine`
Top-level pricing orchestrator. `getQuote()` — best route + fork simulation. `getAmmQuote()` — pool math only, used during signal generation. `startPoolMonitor()` subscribes to on-chain `Sync` events so reserves stay current without polling.

### `exchange/cexClient`
Binance client built on ccxt. All prices and quantities are `bigint` scaled by `PRICE_SCALE`. Sliding-window rate limiter tracks Binance request weights (limit 1100/min). Typed domain errors for every ccxt failure mode.

### `exchange/orderBook`
Order book analysis. `walkTheBook(side, qty)` simulates fills and returns VWAP fill price and slippage in bps. `depthAtBps`, `imbalance`, `effectiveSpread`.

### `inventory/tracker`
Single source of truth for positions. `updateFromCex()` / `updateFromWallet()` replace snapshots on each sync. `canExecute()` checks both legs before execution. `recordTrade()` applies fill deltas after completion.

### `inventory/rebalancer`
Transfer plan generation. Pairs largest surplus venue with largest deficit. Enforces min operating balances and min withdrawal sizes from `VenueProfile`.

### `inventory/pnl`
Per-trade and aggregate PnL. `ArbRecord` holds buy/sell legs with `grossPnl`, `netPnl`, `netPnlBps`. `PnLEngine` tracks win rate, avg bps, Sharpe estimate, and exports CSV.

### `venues`
Per-exchange config profiles. `VenueProfile` holds rate limits, withdrawal fees, min balances, and combined fee rate. `VenueHydrator.hydrate()` fetches live withdrawal fees at startup, falls back to static defaults on testnet.

### `strategy/fee.calculator`
Pure fee math. `totalFee(tradeValue, liveGasCost?)` returns combined CEX taker + DEX swap fees plus gas.

### `strategy/signal.generator`
Generates arb signals. Each tick: walks the CEX order book at trade size, queries the DEX AMM at the same size (both sides include full price impact), fetches live gas from chain, computes both spread directions. Emits a `Signal` when net PnL clears `minProfit`. Enforces per-pair cooldown.

### `strategy/scorer`
Multi-factor signal ranking (0–100):

| Factor | Weight | Source |
|--------|--------|--------|
| Spread | 40% | Linear: minSpreadBps → 0, excellentSpreadBps → 100 |
| Liquidity | 20% | Fixed 80 (placeholder) |
| Inventory | 20% | 60 normally, 20 when rebalance is flagged |
| History | 20% | Win rate of last 20 executions for the pair |

`applyDecay()` applies up to 50% linear decay as the signal ages toward its TTL.

### `safety`
Hard gates before execution. `RiskManager` — daily loss limit, drawdown ceiling, per-trade size, trade frequency. `PreTradeValidator` — spread sanity (rejects > 1000 bps), signal freshness. `absoluteSafetyCheck` — independent ceiling (max $10k/trade, $50 daily loss, $100k capital, 10 trades/hour). `KillSwitch` — file-based, polled every tick. `AutoKillSwitch` — trips after 3 consecutive errors.

### `executor/engine`
Two-legged execution with circuit breaking and replay protection. Pre-flight: circuit breaker (3 failures / 60s window), replay protection (TTL-keyed signal IDs), signal expiry, inventory check. Execution: CEX limit IOC with 0.1% price buffer → DEX on-chain swap with `amountOutMin = min(expectedOutput, simulatedOutput) × (1 − slippage)` → unwind via CEX market order on failure.

### `notifications`
`TelegramNotifier` sends trade alerts, balance snapshots, and error notifications. Listens for `/stop` command to trigger graceful shutdown.

### `integration/arbBot`
Top-level bot service. Wires all layers into a WebSocket depth-driven loop. Derives the CEX trading pair from pool token symbols at startup (WETH → ETH normalization) — no `BOT_PAIR` env var needed.

---

## Running the Bot

### Entry point

```bash
npx tsx src/integration/arbBot/arb_bot.script.ts [options]
```

### CLI options

| Flag | Default | Description |
|------|---------|-------------|
| `--trade-size <usd>` | `5` | Target trade notional in USD |
| `--cooldown <ms>` | `500` | Minimum ms between signals for the same pair |
| `--min-spread <bps>` | `1` | Minimum spread in bps to generate a signal |

### Pipeline

```
startup
  connect to Binance → verify API keys + fetch live withdrawal fees
  fetch CEX balances → InventoryTracker
  load Uniswap V2 pool from chain → derive CEX pair from token symbols
  subscribe to pool Sync events via WebSocket
  fetch Binance trading rules for the derived pair

on each Binance depth update
  safety gates        → kill switch, auto-kill, risk manager
  SignalGenerator     → CEX VWAP walk + DEX AMM quote + live gas → Signal or null
  PreTradeValidator   → spread sanity, signal freshness
  SignalScorer        → composite 0–100 score + time decay
  score < threshold   → skip
  RiskManager         → daily loss, drawdown, size, frequency limits
  AbsoluteSafetyCheck → hard ceiling
  Executor            → circuit breaker → CEX limit IOC → DEX swap → unwind on failure
  PnLEngine           → record ArbRecord → update session summary
  Telegram            → trade notification
```

### Example log output

No signal:
```
INFO  [Signal] [NO_SIGNAL] ETH/USDT  size=0.0548 ETH  threshold=1bps

    cex[Binance]   bid=1823.400000  ask=1823.600000  mid=1823.500000  spread=      10.97bps
    dex[UniV2-Arb] sell=1821.230000  buy=1825.880000  mid=1823.555000  spread=      25.51bps
        pool : 0xF64Dfe17C8b87F012FCf50FbDA1D62bfA148366a

    routes:
        buyCexSellDex  gross=     -12.91bps  unit=-0.0236 USDT  total=-0.0013 USDT
        buyDexSellCex  gross=     -12.58bps  unit=-0.0229 USDT  total=-0.0013 USDT
```

Signal and execution:
```
INFO  [Signal] Signal [ETHUSDTa3f7b2c1] ETH/USDT 0.05 ETH — buy_cex_sell_dex
INFO  [Signal]   prices : cex=$1823.40  dex=$1841.20  spread=97.6bps
INFO  [Signal]   pnl    : gross=$0.89  fees=$0.31  net=$0.58
INFO  [Signal]   score  : 74.0 (raw=74.0, threshold=60)
INFO  [ArbBot]   → Executing 0.05 ETH
INFO  [ArbBot]   session: trades=1 pnl=$0.58 win=100%
```

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

Edit `.env`:

```env
# Mode: sim | paper | live
# sim   — no trades, Binance testnet credentials
# paper — no trades, live Binance credentials (real market data)
# live  — real on-chain txs + real Binance orders
RUN_MODE=sim

# Chain (Arbitrum mainnet)
CHAIN_ID=42161
MAINNET_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/<key>
MAINNET_WS_URL=wss://arb-mainnet.g.alchemy.com/v2/<key>
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/<key>

# Wallet
PRIVATE_KEY=0x...

# Pool (BASE_TOKEN/QUOTE_TOKEN must both exist in the pool)
POOL=0x...
ROUTER=0x...
BASE_TOKEN=0x...
QUOTE_TOKEN=0x...

# Binance (testnet for sim, live for paper/live)
BINANCE_TESTNET_API_KEY=...
BINANCE_TESTNET_SECRET=...
BINANCE_API_KEY=...
BINANCE_SECRET=...

# Telegram
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

### 4. Start a fork (required for DEX simulation)

```bash
anvil --fork-url $MAINNET_RPC_URL --port 8545
```

---

## Configuration

### `RUN_MODE`

| Value | On-chain txs | Binance credentials | Use case |
|-------|-------------|---------------------|----------|
| `sim` | no | testnet | development, testing |
| `paper` | no | live | verify real spreads without trading |
| `live` | yes | live | production |

### Pool and pair

Set `BASE_TOKEN` and `QUOTE_TOKEN` to the on-chain addresses of the two tokens in your pool. The bot derives the Binance pair automatically from the token symbols (`WETH` → `ETH`). No `BOT_PAIR` env var is needed.

To find a viable pool first:

```bash
npx tsx src/scripts/scan_pools.script.ts       # scan many tokens at once
npx tsx src/scripts/find_pool.script.ts        # check a specific BASE_TOKEN/QUOTE_TOKEN pair
npx tsx src/scripts/verify_pool.script.ts      # verify configured pool has non-zero reserves
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

### Pool discovery

```bash
# Scan Uniswap V2 for TOKEN/WETH pools with Binance depth — saves scan_results.json
npx tsx src/scripts/scan_pools.script.ts

# Find a specific BASE_TOKEN/QUOTE_TOKEN pair across Uniswap V2 and SushiSwap V2
npx tsx src/scripts/find_pool.script.ts

# Verify the configured POOL has non-zero reserves and print implied price
npx tsx src/scripts/verify_pool.script.ts
```

### Pipeline verification

```bash
# Test signing + broadcast pipeline on Sepolia (safe, no real funds)
npx tsx src/scripts/test_dex_leg.script.ts           # gas estimate only
npx tsx src/scripts/test_dex_leg.script.ts --send    # send 0-value self-transfer

# Watch live Sync events on your configured pool
npx tsx src/scripts/verify_sync_events.ts

# Watch pending mempool swaps
npx tsx src/scripts/verify_mempool.ts
```

### Market data

```bash
# Live Binance order book with depth, imbalance, and walk-the-book simulation
npx tsx src/scripts/orderBook.script.ts ETH/USDC --depth 20

# Full arb opportunity assessment — read-only, no orders placed
npx tsx src/scripts/arb_checker.script.ts --pair ETH/USDC --size 2.0

# Live Uniswap V2 pool pricing (add FORK_URL for fork-validated quotes)
npx tsx src/scripts/pricing.script.ts
```

### Account management

```bash
# Cross-venue balance snapshot with skew report
npx tsx src/scripts/portfolio.script.ts

# Rebalance plan with fee accounting
npx tsx src/scripts/rebalancer.script.ts --check
npx tsx src/scripts/rebalancer.script.ts --plan ETH

# Place and immediately cancel a test limit order
npx tsx src/scripts/order.script.ts ETH/USDC
```

---

## Tests

```bash
npm test
```

Tests live in `tests/`, mirroring `src/`. Covers chain, pricing, exchange, inventory, strategy, executor, and safety modules.
