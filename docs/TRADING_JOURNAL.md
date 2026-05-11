# Trading Journal — ARB/USDC Arbitrage Bot

---

## Day 1 — 2026-05-09

### Numbers
- Starting capital: ~$97.28 (340.78 ARB total @ $0.1394 + $46.78 USDC total + $2.96 ETH)
- Ending capital: ~$98.14 (340.78 ARB total @ $0.1420 + $46.79 USDC total + $2.96 ETH) — +$0.86 from ARB price appreciation, not trade PnL
- PnL: -$0.0161
- Trades: 1 (0 wins, 1 loss)
- Win rate: 0%
- Best trade: -$0.0161
- Worst trade: -$0.0161
- Fees paid: ~$0.006 (CEX taker) + ~$0.018 (DEX gas) = $0.0240 total
- Direction: `buy_dex_sell_cex`
- Tx hash: 0x2d9a872ec0c7f086897f28751c4f98a361ea1ee93f42c3ac4aa18d3e27054f72

### What Happened
- First real on-chain trade executed after extended debugging session
- Bot running on Arbitrum One, pair ARB/USDC via Camelot V2 pool (`0x011f31D20C8778c8Beb1093b73E3A5690Ee6271b`)
- Trading in testnet/low-risk mode with `MIN_PROFIT_USD = -0.02` to allow small loss trades for testing

### Problems Encountered
- **Fork simulator approval issue**: `simulateRoute` called `swapExactTokensForTokens` via eth_call on Anvil fork which doesn't have token approvals. Fixed by switching to `getAmountsOut` (view-only, no approval needed).
- **estimateGas timing revert**: Pool state shifts between `getQuote` and `estimateGas` causing intermittent reverts. Fixed by using fixed 200k gas limit instead.
- **Flashbots relay wrong chain**: `useFlashbots: true` was routing transactions to `relay.flashbots.net` (mainnet only). Fixed: disabled for Arbitrum.
- **MIN_NOTIONAL breach**: Trade size $5 × ARB price ≈ $4.99, just below Binance's $5 minimum. Fixed by raising `TRADE_SIZE_USD` to $6.

### Changes Made
- `fork.service.ts`: `simulateRoute` now uses `getAmountsOut` instead of simulating full swap
- `engine.types.ts`: Quote tolerance raised from 10 bps → 100 bps
- `engine.constants.ts`: Added `DEX_SWAP_GAS_LIMIT = 200_000n`; executor uses fixed gas instead of `estimateGas`
- `arb_bot.service.ts`: `useFlashbots: false` (Flashbots not available on Arbitrum)
- `arb_bot.script.ts`: `TRADE_SIZE_USD/MIN/MAX` raised from $5 → $6 to clear Binance MIN_NOTIONAL

### Lessons Learned
- Always verify the router ABI against the actual deployed contract using `cast call` before assuming it matches a known fork
- Flashbots only works on Ethereum mainnet — Arbitrum uses the sequencer directly
- Pool state changes fast; pre-trade simulations that check approval state (via `swapExactTokensForTokens`) are fragile — use read-only `getAmountsOut` instead
- Keep trade size well above exchange MIN_NOTIONAL — right at the boundary is not safe

### Tomorrow's Plan
- Make minimal profit to -0.01 or -0.005 USD
- Balance risk balance consts
---

## Day 2 — 2026-05-10

### Numbers
- Starting capital: ~$98.28 (340.78 ARB total @ $0.1424 + $46.79 USDC total + $2.96 ETH)
- Ending capital: ~$98.20 (after -$0.0815 net loss across 3 trades; ARB price drift not tracked per-session)
- PnL: -$0.0815 (-$0.0328 + -$0.0328 + -$0.0159)
- Trades: 3 (0 wins, 3 losses)
- Win rate: 0%
- Best trade: -$0.0159
- Worst trade: -$0.0328
- Fees paid: ~$0.0240 × 3 = $0.0720 total (CEX taker + DEX pool per trade)

| Time  | Direction          | Size (ARB) | Spread | Gross PnL | Net PnL   | Tx hash |
|-------|--------------------|-----------|--------|-----------|-----------|---------|
| 17:21 | Buy CEX → Sell DEX | 42.1348   | 27.3 bps | +$0.0164 | -$0.0328 | 0x4b8d3bfcabd3de117a23809c5b181b32bfb49817efe87068d58069f5c6885695       |
| 17:28 | Buy CEX → Sell DEX | 42.4929   | 13.4 bps | +$0.0080 | -$0.0159 |  0x9c081bf6ecf4c39a618041613990fa558fd0ccb62d3d65404c838dd9f0014930      |
| 23:49    | Buy CEX → Sell DEX | 42.8571    | 33.6 bps | +$0.0202  | -$0.0081 | 0xeab2fff13a0d133d8a7a664a5c4b4584c2131c0b0c2f094e2b50e96959293243       |

### What Happened
- **17:21** — Bought 42.1348 ARB on CEX @ $0.1424, sold on DEX @ $0.1428 (27.3 bps spread). Before our DEX leg executed, a large trade (109.9 ARB sell, SYNC #1) hit the pool, pushing price from $0.1428 → ~$0.1423. DEX leg received only $5.99 ($0.14228/ARB). Extra $0.025 slippage loss.
- **17:28** — Bought 42.4929 ARB on CEX @ $0.1412, sold on DEX @ $0.1414 (13.4 bps spread). Signal was well below the 40 bps break-even — guaranteed loss before execution.
- All three trades had `buy_cex_sell_dex` direction; all ran with loose test config (`MIN_SPREAD_BPS = 2`), allowing signals far below the 40 bps fee floor.

### Problems Encountered
- **CEX-first execution exposes DEX leg to price movement**: After CEX fills, we're committed — the pool can move significantly before the DEX tx lands
- **Signal spread below break-even**: 27.3 bps and 13.4 bps are both below the 40 bps minimum needed to cover CEX taker (10 bps) + DEX pool fee (30 bps)
- **Pool slippage amplified the first loss**: large seller front-ran our DEX leg by ~1 block

### Changes Made
- Reverted to loose test config: `MIN_SPREAD_BPS = 2`, `MIN_PROFIT_USD = -0.02`, `COOLDOWN_MS = 250`

---

<!-- Template for future days — copy below this line -->

<!--
## Day X — YYYY-MM-DD

### Numbers
- Starting capital: ~$
- Ending capital: ~$
- PnL:
- Trades: N (N wins, N losses)
- Win rate:
- Best trade:
- Worst trade:
- Fees paid:
- Direction:
- Tx hash:

### What Happened
-

### Problems Encountered
-

### Changes Made
-

### Lessons Learned
-

### Tomorrow's Plan
- [ ]
-->
