# Ethereum DeFi Pricing Engine

TypeScript infrastructure for Ethereum DeFi — wallet management, on-chain queries, transaction analysis, and a full AMM pricing engine with routing, mempool monitoring, and fork simulation.

---

### Data flow

```
MempoolMonitor (WebSocket)
       │ ParsedSwap
       ▼
PricingEngine.onMempoolSwap()
       │ refreshPool()
       ▼
UniswapV2Pair.fromChain()  ──── ChainClient (RPC)
       │
       ▼
RouteFinder.findBestRoute()
       │ Route (pools + path)
       ▼
ForkSimulator.simulateRoute()  ──── Anvil fork (eth_call)
       │ SimulationResult
       ▼
Quote { expectedOutput, simulatedOutput, gasEstimate, isValid }
```

---

## Modules

### `core`

Shared primitives used across all other modules. `core.types.ts` defines `Address`, `Token`, and `TokenAmount` — the building blocks for everything else. `AppError` in `core.errors.ts` is the base for all domain errors; it strips 32-byte hex from messages to prevent private keys from leaking into logs. `WalletManager` handles key loading from env or encrypted keyfile and signs messages, typed data, and transactions.

### `chain`

Ethereum RPC layer. `ChainClient` wraps viem's `PublicClient` with multi-endpoint failover and exponential backoff retries. `TransactionService` builds and submits EIP-1559 transactions — it estimates gas, signs, broadcasts, and waits for receipt. `GasCalculator` computes base fee + priority fee from recent blocks. The `analyzer/` sub-module is a CLI tool: given a tx hash, it decodes calldata, logs token transfers, shows gas breakdown, and optionally renders the internal call tree via `debug_traceTransaction`.

### `pricing/uniswap-v2`

AMM math and on-chain pair state. `UniswapV2Pair` loads reserves and token metadata from the chain via a single `fromChain(address, client)` call. `UniswapV2Calculator` is pure math — `getAmountOut`, `getAmountIn`, spot price, and price impact — implemented with `bigint` to match Solidity integer arithmetic exactly. `PriceImpactAnalyzer` builds an impact table across input sizes and computes the maximum swap size before a given impact threshold is exceeded.

### `pricing/routing`

Multi-hop route discovery. `RouteFinder` does a DFS over a graph of pairs to find the best path from token A to token B. Routes are ranked by gas-adjusted net output — gross output minus estimated gas cost — so a cheaper 2-hop route beats a more-output 3-hop route when gas dominates.

### `pricing/mempool`

Live mempool monitoring over WebSocket. `MempoolMonitor` subscribes to `eth_subscribe("newPendingTransactions")`, fetches each transaction, decodes it against known Uniswap V2 router selectors, and calls a user-provided callback with a `ParsedSwap` — normalized swap intent with router, tokenIn, tokenOut, amountIn, and minAmountOut.

### `pricing/forkSimulator`

Simulation against a local Anvil fork via `eth_call`. `ForkSimulator.simulateRoute` encodes a router `swapExactTokensForTokens` call and sends it as `eth_call` — no transaction is broadcast, no state is mutated. This lets you validate AMM math against the real Solidity bytecode running at a specific block. `compareSimulationVsCalculation` runs both paths and returns the diff.

### `pricing/integration`

Top-level orchestrator. `PricingEngine` holds a pool registry (`Map<string, UniswapV2Pair>`), a `RouteFinder`, and a `MempoolMonitor`. `loadPools` hydrates all pairs in parallel. `getQuote` finds the best route, calculates expected output, simulates against the fork, and returns a `Quote` with an `isValid` flag (simulation within 0.1% of calculated). `onMempoolSwap` refreshes affected pools when the mempool sees a swap touching a tracked pair.

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Install Foundry (required for fork simulation)

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

Verify:

```bash
anvil --version
```

### 3. Configure environment

```bash
cp .env.example .env
```

```env
MAINNET_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY   # required
PRIVATE_KEY=0x...                                                 # required
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY    # optional
PORT=3000                                                         # optional, default 3000
```

To generate a fresh wallet:

```bash
npx tsx -e "import('./src/core/wallet.service.ts').then(m => m.WalletManager.generate())"
```

---

## Commands

| Command | Description |
|---------|-------------|
| `npm test` | Run all unit tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run lint` | Lint `src/` |
| `npm run format` | Format `src/` with Prettier |

---

## Scripts

### Unit tests

```bash
npm test
```

### Price impact table (live mainnet)

```bash
npx tsx src/scripts/demo_impact.ts
```

Loads the USDC/WETH pool from mainnet and prints how much slippage each trade size incurs, plus the largest swap that stays within 1% impact.

### Route finding (live mainnet)

```bash
npx tsx src/scripts/demo_routing.ts
```

Loads DAI/WETH, USDC/WETH, and DAI/USDC pools, then ranks every route from DAI → USDC by net output (gross output minus gas cost). Shows both the 1-hop direct route and the 2-hop route via WETH.

### Mempool monitoring (live mainnet WebSocket)

```bash
npx tsx src/scripts/verify_mempool.ts
```

Connects to mainnet via WebSocket (`MAINNET_RPC_URL`) and logs decoded Uniswap V2 swaps as they appear in the public mempool. Press Ctrl+C to stop.

### AMM math vs on-chain router

Start a local Anvil fork first:

```bash
./src/scripts/start_fork.sh
```

Then verify our TypeScript math matches the real Solidity bytecode:

```bash
npx tsx src/scripts/verify_amm.ts
```

Encodes a 2000 USDC swap, runs it as `eth_call` on the fork, and compares the result to our pure-TypeScript calculation. Exits 0 if they match exactly.
