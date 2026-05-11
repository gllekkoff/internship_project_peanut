# Week 6 Report — CEX-DEX Arbitrage Bot

**Pair:** ARB/USDC | **Period:** 2026-05-09 to 2026-05-11

---

## 1. Configuration & Setup

**Stack:** Arbitrum One, Camelot V2 (Uniswap V2 fork), Binance testnet.

**Key settings:**

| Setting | Value | Why |
|---|---|---|
| Trade size | $6–$8 | $6 minimum clears Binance's $5 MIN_NOTIONAL floor |
| Min spread | 2 bps | Intentionally loose — just to get real trades executing |
| Min profit | -$0.02 -> $0| Allows small losses during calibration |
| Min score | 40 | Lets most signals through |
| Max daily loss | $15 | Hard stop before things get bad |
| Consecutive loss limit | 1-3 | Halts after one loss — turned out too tight |

Break-even spread is 40 bps (10 bps CEX fee + 30 bps DEX pool fee). Running at 2 bps was a conscious choice — profit wasn't the goal, pipeline validation was.

**Surprises going live:**

- **Flashbots doesn't work on Arbitrum.** It's mainnet-only. The bot was silently sending transactions to the wrong relay. Fixed by disabling Flashbots.
- **Anvil fork has no token approvals.** The fork snapshots chain state but not the wallet's live approvals. Had to write a separate script (`approve_fork.script.ts`) to set approvals on the fork before starting the bot.

---

## 2. Trading Results

| Metric | Value |
|---|---|
| Trades | 5 (0 wins, 5 losses) |
| Win rate | 0% |
| Total PnL | -$0.1057 |
| Fees paid | $0.12 (~$0.024/trade) |
| Starting capital | ~$97.28 |
| Ending capital | ~$98.19 (ARB price up +$0.91, trades lost -$0.11) |

| Day | Spread | Net PnL | Note |
|---|---|---|---|
| 1 | 27.3 bps | -$0.0328 | Another trader hit the pool in the 2s gap between CEX fill and DEX leg |
| 2 | 13.4 bps | -$0.0159 | Way below break-even |
| 3 | 27.3 bps | -$0.0328 | Same as first Day 2 trade |
| 4 | 33.6 bps | -$0.0081 | Closest to break-even |

**Best trade:** Day 3, -$0.0081. Only $0.004 away from profit — spread was 33.6 bps, just below the 40 bps floor.

**Worst trade:** Day 2, -$0.0328 (twice). Signal was already below break-even, then a 109 ARB sell hit the pool right before our DEX leg landed, adding extra slippage.

Also lost 1 protitable trade because of `getQuote` issue with tolerance.

2026-05-10 23:33:08 INFO  [ArbBot] ────────────────────────────────────────────────────────────
2026-05-10 23:33:08 INFO  [ArbBot] SIGNAL — ARB/USDC buy_cex_sell_dex
2026-05-10 23:33:08 INFO  [ArbBot]   Signal ID  : ARBUSDC_42ac10ab
2026-05-10 23:33:08 INFO  [ArbBot]   Size       : 42.1644 ARB
2026-05-10 23:33:08 INFO  [ArbBot]   CEX price  : $0.1423
2026-05-10 23:33:08 INFO  [ArbBot]   DEX price  : $0.1429
2026-05-10 23:33:08 INFO  [ArbBot]   Spread     : 42.6 bps
2026-05-10 23:33:08 INFO  [ArbBot]   Gross PnL  : $0.0255
2026-05-10 23:33:08 INFO  [ArbBot]   Fees       : $0.0240
2026-05-10 23:33:08 INFO  [ArbBot]   Net PnL    : $0.0015
2026-05-10 23:33:08 INFO  [ArbBot]   Score      : 55 / 100 (threshold 40)
2026-05-10 23:33:08 INFO  [ArbBot]   Expires    : 2026-05-10T20:33:13.774Z
2026-05-10 23:33:08 INFO  [ArbBot] ────────────────────────────────────────────────────────────

---

## 3. Risk Management in Practice

**Circuit breaker:** Tripped once on Day 2 after back-to-back DEX failures. Bot paused, sent a Telegram alert, and resumed cleanly after the cooldown.

**Kill switch:** Never triggered. Losses were too small (~$0.10 total) to cross any capital drawdown threshold.

**Scariest moment:** `getQuote` issue with bidirectional tolerance.

**What actually saved money:** `minProfitBuffer` — a dynamic floor that scales with trade size and fees. It blocked signals where gross PnL barely covered costs.

---

## 4. What I Learned

**Biggest surprise:** That on second day there was a profitable trade that I've missed. And also it's a really alive pool, there alot of low -netPnL trades going on.

**With $1,000 I would:**
- Size trades dynamically based on pool depth
- Watch multiple pools and pick the best one per signal

**Most confident code:** `InventoryTracker`, `FeeCalculator` — pure math, no side effects, easy to verify.

**Least confident code:** `Executor` — coordinates two external systems (CEX WebSocket + on-chain tx) in sequence with unwind logic on failure. High number of timing-dependent states, and two bugs only appeared in production.

**What I wish I'd built earlier:** More telegram notifications, like error alerts. One-directional tolerance, since other side of trap bps is on risk manager. 

---

## 5. Technical Challenges

**L2 specifics:** Arbitrum has no mempool — transactions go straight to the sequencer and confirm in 1–2 seconds. No Flashbots, no front-running protection needed, gas is cheap (~$0.02/swap). Good for small trade sizes that wouldn't be viable on mainnet.

**Gas estimation:** `estimateGas` failed intermittently because pool state changes between the estimate call and execution. Replaced with a fixed 200k gas limit (actual usage ~140k). Works but wastes gas.

**Latency:** CEX fill takes ~1 second via WebSocket. DEX confirmation takes ~1–2 seconds. Total gap between legs: 2–3 seconds. The pool can change a lot in that time — observed directly in logs.

**Bugs only found in production:**
- Fork missing live approvals → simulation fails
- Flashbots chain mismatch → transaction rejected
- Quote tolerance rejected favorable price moves → lost a profitable trade
- Balance mismatch check halted bot after clean unwind

---

## 6. Beyond Spot Arbitrage

**Strategy: Funding Rate Arbitrage**

Perpetual futures pay a funding rate every 8 hours to keep their price close to spot. When funding is positive, shorts receive payment from longs.

**The trade:** Buy ARB spot + short ARB perp on GMX or Hyperliquid. The two positions cancel out price risk - you don't care if ARB goes up or down. The profit is the funding payment collected every 8 hours.

**Why it connects to what I built:** The inventory tracker, multi-venue balances, and two-leg executor are already most of what's needed. The main change is a new signal source (funding rate instead of order book spread) and a margin/liquidation risk model.

**Would I pursue it?** Yes. ARB funding rates spike above 0.05% per 8 hours (~50% APR) during trending markets. It's slower and less competitive than spot arb - no need for millisecond execution. The capital requirement is similar and the infrastructure is already mostly there. The missing piece is proper margin monitoring, which the current `RiskManager` doesn't handle.
