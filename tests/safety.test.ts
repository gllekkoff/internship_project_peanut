import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { PRICE_SCALE } from '@/core/core.constants';
import {
  isKillSwitchActive,
  AutoKillSwitch,
  HEARTBEAT_FILE,
  ERROR_WINDOW_MS,
  MAX_ERRORS_PER_HOUR,
  CAPITAL_FLOOR_PCT,
  _resetKillSwitchCacheForTesting,
} from '@/safety/kill.switch';
import { RiskManager } from '@/safety/risk.service';
import { PreTradeValidator } from '@/safety/pre.trade.validator';
import {
  absoluteSafetyCheck,
  ABSOLUTE_MAX_TRADE_USD,
  ABSOLUTE_MAX_DAILY_LOSS,
  ABSOLUTE_MIN_CAPITAL,
  ABSOLUTE_MAX_TRADES_PER_HOUR,
} from '@/safety/safety.constants';
import { DEFAULT_RISK_LIMITS } from '@/safety/risk.constants';
import { Signal, Direction } from '@/strategy/signal.interfaces';

// ─── helpers ──────────────────────────────────────────────────────────────────

function s(n: number): bigint {
  return BigInt(Math.round(n * Number(PRICE_SCALE)));
}

function makeSignal(overrides: Partial<{
  cexPrice: bigint;
  dexPrice: bigint;
  size: bigint;
  spreadBps: number;
  expectedNetPnl: bigint;
  expectedGrossPnl: bigint;
  expectedFees: bigint;
  score: number;
  timestamp: Date;
  expiry: Date;
  inventoryOk: boolean;
  withinLimits: boolean;
}> = {}): Signal {
  const now = new Date();
  return new Signal({
    signalId: 'test_001',
    pair: 'ETH/USDT',
    direction: Direction.BUY_DEX_SELL_CEX,
    cexPrice: overrides.cexPrice ?? s(3000),
    dexPrice: overrides.dexPrice ?? s(2980),
    spreadBps: overrides.spreadBps ?? 100,
    size: overrides.size ?? s(0.006),
    expectedGrossPnl: overrides.expectedGrossPnl ?? s(20),
    expectedFees: overrides.expectedFees ?? s(8),
    expectedNetPnl: overrides.expectedNetPnl ?? s(12),
    score: overrides.score ?? 70,
    timestamp: overrides.timestamp ?? now,
    expiry: overrides.expiry ?? new Date(now.getTime() + 5_000),
    inventoryOk: overrides.inventoryOk ?? true,
    withinLimits: overrides.withinLimits ?? true,
  });
}

// ─── isKillSwitchActive ────────────────────────────────────────────────────────

const KILL_FILE = '/tmp/arb_bot_kill';

describe('isKillSwitchActive', () => {
  beforeEach(() => {
    if (existsSync(KILL_FILE)) unlinkSync(KILL_FILE);
    _resetKillSwitchCacheForTesting();
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (existsSync(KILL_FILE)) unlinkSync(KILL_FILE);
    vi.useRealTimers();
  });

  it('returns false when kill file is absent', () => {
    // Cache is fresh-reset in beforeEach → first call always re-stats.
    expect(isKillSwitchActive()).toBe(false);
  });

  it('returns true when kill file exists', () => {
    writeFileSync(KILL_FILE, '');
    // Cache reset in beforeEach → first call re-stats and detects the file.
    expect(isKillSwitchActive()).toBe(true);
  });

  it('caches the result for 1 second — does not restat immediately', () => {
    // Seed cache: file absent.
    expect(isKillSwitchActive()).toBe(false);
    // File appears but cache is still warm (0 ms elapsed).
    writeFileSync(KILL_FILE, '');
    expect(isKillSwitchActive()).toBe(false);
    // After TTL expires the cache refreshes and detects the file.
    vi.advanceTimersByTime(1_100);
    expect(isKillSwitchActive()).toBe(true);
  });

  it('returns false again after kill file is removed and cache expires', () => {
    writeFileSync(KILL_FILE, '');
    expect(isKillSwitchActive()).toBe(true);   // seeds cache as active

    unlinkSync(KILL_FILE);
    vi.advanceTimersByTime(1_100);             // cache expires
    expect(isKillSwitchActive()).toBe(false);
  });
});

// ─── AutoKillSwitch ───────────────────────────────────────────────────────────

describe('AutoKillSwitch — capital floor', () => {
  it('does not trigger when capital is above the floor', () => {
    const ks = new AutoKillSwitch();
    expect(ks.check(s(60), s(100))).toBe(false);
  });

  it('triggers when capital drops below CAPITAL_FLOOR_PCT of initial', () => {
    const ks = new AutoKillSwitch();
    const initial = s(100);
    // Exactly at the floor (50%) should NOT trigger (< not <=).
    expect(ks.check(s(50), initial)).toBe(false);
    // One cent below the floor should trigger.
    expect(ks.check(s(49.99), initial)).toBe(true);
  });

  it('once triggered, always returns true regardless of recovered capital', () => {
    const ks = new AutoKillSwitch();
    expect(ks.check(s(40), s(100))).toBe(true);
    expect(ks.check(s(200), s(100))).toBe(true);
  });

  it('exposes the trigger reason', () => {
    const ks = new AutoKillSwitch();
    ks.check(s(40), s(100));
    expect(ks.reason).toContain('%');
    expect(ks.isTriggered).toBe(true);
  });
});

describe('AutoKillSwitch — error storm', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not trigger below MAX_ERRORS_PER_HOUR', () => {
    const ks = new AutoKillSwitch();
    for (let i = 0; i < MAX_ERRORS_PER_HOUR; i++) ks.recordError();
    expect(ks.check(s(100), s(100))).toBe(false);
  });

  it('triggers when errors exceed MAX_ERRORS_PER_HOUR within the window', () => {
    const ks = new AutoKillSwitch();
    for (let i = 0; i <= MAX_ERRORS_PER_HOUR; i++) ks.recordError();
    expect(ks.check(s(100), s(100))).toBe(true);
    expect(ks.reason).toContain('Error storm');
  });

  it('does not trigger when old errors have expired outside the window', () => {
    const ks = new AutoKillSwitch();
    // Record MAX_ERRORS_PER_HOUR + 1 errors then move the clock past the window.
    for (let i = 0; i <= MAX_ERRORS_PER_HOUR; i++) ks.recordError();
    vi.advanceTimersByTime(ERROR_WINDOW_MS + 1);
    expect(ks.check(s(100), s(100))).toBe(false);
  });
});

// ─── RiskManager ─────────────────────────────────────────────────────────────

describe('RiskManager.checkPreTrade — trade size limits', () => {
  it('blocks when trade exceeds maxTradeUsd', () => {
    const rm = new RiskManager(DEFAULT_RISK_LIMITS, s(200));
    // $18 trade at $3000/ETH → size 0.006 ETH
    const signal = makeSignal({ cexPrice: s(3000), size: s(0.007) }); // $21 > $20 limit
    const result = rm.checkPreTrade(signal);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('exceeds max');
  });

  it('blocks when trade exceeds maxTradePct of capital', () => {
    // Capital $50, maxTradePct=0.2 → max by pct = $10. Trade = $18 > $10.
    const rm = new RiskManager({ ...DEFAULT_RISK_LIMITS, maxTradeUsd: 100n * PRICE_SCALE }, s(50));
    const signal = makeSignal({ cexPrice: s(3000), size: s(0.006) }); // $18 trade
    const result = rm.checkPreTrade(signal);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('% of capital');
  });

  it('allows a trade within both absolute and pct limits', () => {
    const rm = new RiskManager(DEFAULT_RISK_LIMITS, s(200));
    const signal = makeSignal({ cexPrice: s(3000), size: s(0.006) }); // $18 trade
    expect(rm.checkPreTrade(signal).allowed).toBe(true);
  });
});

describe('RiskManager.checkPreTrade — loss limits', () => {
  it('blocks when expected loss exceeds maxLossPerTrade', () => {
    const rm = new RiskManager(DEFAULT_RISK_LIMITS, s(200));
    const signal = makeSignal({ expectedNetPnl: -s(6) }); // -$6 > limit of $5
    expect(rm.checkPreTrade(signal).allowed).toBe(false);
  });

  it('blocks after daily loss limit is reached', () => {
    const rm = new RiskManager(DEFAULT_RISK_LIMITS, s(200));
    rm.recordTrade(-s(15)); // -$15 meets the $15 maxDailyLoss
    const signal = makeSignal();
    const result = rm.checkPreTrade(signal);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Daily loss');
  });

  it('resets daily loss after resetDaily()', () => {
    const rm = new RiskManager(DEFAULT_RISK_LIMITS, s(200));
    rm.recordTrade(-s(15));
    rm.resetDaily();
    expect(rm.checkPreTrade(makeSignal()).allowed).toBe(true);
  });
});

describe('RiskManager.checkPreTrade — drawdown', () => {
  it('blocks when drawdown exceeds maxDrawdownPct', () => {
    // $200 initial → $42 loss (21% drawdown) → remaining $158.
    // 20% of $158 = $31.6 which is above the $18 test trade, so pct-cap fires AFTER drawdown.
    // Raise daily-loss and maxTradeUsd caps so only the drawdown check can fire.
    const limits = { ...DEFAULT_RISK_LIMITS, maxTradeUsd: 100n * PRICE_SCALE, maxDailyLoss: 1_000n * PRICE_SCALE };
    const rm = new RiskManager(limits, s(200));
    rm.recordTrade(-s(42)); // 21% drawdown
    const result = rm.checkPreTrade(makeSignal());
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Drawdown');
  });

  it('does not block when capital is at peak (zero drawdown)', () => {
    const rm = new RiskManager(DEFAULT_RISK_LIMITS, s(200));
    expect(rm.checkPreTrade(makeSignal()).allowed).toBe(true);
  });
});

describe('RiskManager.checkPreTrade — consecutive losses', () => {
  it('blocks after hitting consecutiveLossLimit', () => {
    const rm = new RiskManager(DEFAULT_RISK_LIMITS, s(1000));
    for (let i = 0; i < DEFAULT_RISK_LIMITS.consecutiveLossLimit; i++) {
      rm.recordTrade(-s(1));
    }
    const result = rm.checkPreTrade(makeSignal());
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Consecutive loss');
  });

  it('resets consecutive loss counter on a winning trade', () => {
    const rm = new RiskManager(DEFAULT_RISK_LIMITS, s(1000));
    rm.recordTrade(-s(1));
    rm.recordTrade(-s(1));
    rm.recordTrade(s(1)); // win resets counter
    expect(rm.checkPreTrade(makeSignal()).allowed).toBe(true);
  });
});

describe('RiskManager.checkPreTrade — hourly trade rate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('blocks when hourly trade limit is reached', () => {
    const rm = new RiskManager(DEFAULT_RISK_LIMITS, s(1000));
    for (let i = 0; i < DEFAULT_RISK_LIMITS.maxTradesPerHour; i++) {
      rm.recordTrade(s(0.1));
    }
    const result = rm.checkPreTrade(makeSignal());
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Hourly');
  });

  it('unblocks after old trades roll out of the 1-hour window', () => {
    const rm = new RiskManager(DEFAULT_RISK_LIMITS, s(1000));
    for (let i = 0; i < DEFAULT_RISK_LIMITS.maxTradesPerHour; i++) {
      rm.recordTrade(s(0.1));
    }
    vi.advanceTimersByTime(60 * 60 * 1_000 + 1);
    expect(rm.checkPreTrade(makeSignal()).allowed).toBe(true);
  });
});

describe('RiskManager.status', () => {
  it('returns correct metrics after recording trades', () => {
    const rm = new RiskManager(DEFAULT_RISK_LIMITS, s(100));
    rm.recordTrade(s(5));
    rm.recordTrade(-s(3));
    const st = rm.status();
    expect(st.dailyPnlUsd).toBeCloseTo(2, 4);
    expect(st.currentCapitalUsd).toBeCloseTo(102, 4);
    expect(st.consecutiveLosses).toBe(1);
    expect(st.tradesThisHour).toBe(2);
  });
});

// ─── PreTradeValidator ────────────────────────────────────────────────────────

describe('PreTradeValidator.validateSignal', () => {
  it('rejects a signal with zero CEX price', () => {
    const v = new PreTradeValidator();
    const result = v.validateSignal(makeSignal({ cexPrice: 0n }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('CEX price');
  });

  it('rejects a signal with zero DEX price', () => {
    const v = new PreTradeValidator();
    const result = v.validateSignal(makeSignal({ dexPrice: 0n }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('DEX price');
  });

  it('rejects a signal with spread above 500 bps (likely bad data)', () => {
    const v = new PreTradeValidator();
    const result = v.validateSignal(makeSignal({ spreadBps: 501 }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('too high');
  });

  it('accepts a spread exactly at the limit', () => {
    const v = new PreTradeValidator();
    // First call seeds the price history — second would detect deviation if price changed much.
    expect(v.validateSignal(makeSignal({ spreadBps: 500 })).allowed).toBe(true);
  });

  it('rejects a stale signal older than maxSignalAgeS', () => {
    const v = new PreTradeValidator();
    const old = new Date(Date.now() - 6_000);
    const result = v.validateSignal(makeSignal({ timestamp: old }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('old');
  });

  it('rejects a signal with zero size', () => {
    const v = new PreTradeValidator();
    const result = v.validateSignal(makeSignal({ size: 0n }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('size');
  });

  it('accepts a fresh valid signal', () => {
    const v = new PreTradeValidator();
    expect(v.validateSignal(makeSignal()).allowed).toBe(true);
  });
});

describe('PreTradeValidator.validatePriceFeed — anomaly detection', () => {
  it('accepts prices within 5% of recent average', () => {
    const v = new PreTradeValidator();
    const base = s(3000);
    v.validatePriceFeed(base, 'ETH/USDT');
    // 2% deviation — within limit.
    const result = v.validatePriceFeed(s(3060), 'ETH/USDT');
    expect(result.allowed).toBe(true);
  });

  it('rejects price that deviates more than 5% from recent average', () => {
    const v = new PreTradeValidator();
    v.validatePriceFeed(s(3000), 'ETH/USDT');
    // 10% spike.
    const result = v.validatePriceFeed(s(3300), 'ETH/USDT');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('deviates');
  });

  it('accepts any price when history is empty (no baseline yet)', () => {
    const v = new PreTradeValidator();
    expect(v.validatePriceFeed(s(3000), 'ETH/USDT').allowed).toBe(true);
  });

  it('uses configurable deviation threshold', () => {
    const v = new PreTradeValidator({ maxPriceDeviation: 0.10 });
    v.validatePriceFeed(s(3000), 'ETH/USDT');
    // 8% spike — would fail with default 5% but passes with 10%.
    expect(v.validatePriceFeed(s(3240), 'ETH/USDT').allowed).toBe(true);
  });
});

// ─── absoluteSafetyCheck ─────────────────────────────────────────────────────

describe('absoluteSafetyCheck', () => {
  const ok = (overrides: {
    tradeUsd?: bigint;
    dailyLoss?: bigint;
    capital?: bigint;
    trades?: number;
  } = {}) =>
    absoluteSafetyCheck(
      overrides.tradeUsd ?? s(18),
      overrides.dailyLoss ?? 0n,
      overrides.capital ?? s(100),
      overrides.trades ?? 0,
    );

  it('passes all-green inputs', () => {
    expect(ok().allowed).toBe(true);
  });

  it('blocks when trade exceeds absolute max', () => {
    const result = ok({ tradeUsd: ABSOLUTE_MAX_TRADE_USD + 1n });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('absolute max');
  });

  it('blocks when daily loss meets the absolute ceiling', () => {
    const result = ok({ dailyLoss: -ABSOLUTE_MAX_DAILY_LOSS });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('daily loss');
  });

  it('blocks when capital falls below the absolute minimum', () => {
    const result = ok({ capital: ABSOLUTE_MIN_CAPITAL - 1n });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('minimum');
  });

  it('blocks when hourly trade count meets the absolute ceiling', () => {
    const result = ok({ trades: ABSOLUTE_MAX_TRADES_PER_HOUR });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('hourly');
  });

  it('all checks are independent — first failing check wins', () => {
    const result = absoluteSafetyCheck(
      ABSOLUTE_MAX_TRADE_USD + 1n,
      -ABSOLUTE_MAX_DAILY_LOSS,
      ABSOLUTE_MIN_CAPITAL - 1n,
      ABSOLUTE_MAX_TRADES_PER_HOUR,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('absolute max');
  });
});
