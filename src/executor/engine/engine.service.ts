import { encodeFunctionData, decodeEventLog, type Hex } from 'viem';
import { PRICE_SCALE, PRICE_SCALE_NUM } from '@/core/core.constants'; // PRICE_SCALE_NUM used at ccxt boundary
import { makeLogger, logError } from '@/core/core.logger';
import { sleep } from '@/chain/chain.utils';
import { Address, type Token } from '@/core/core.types';
import type { ChainClient } from '@/chain/chain.client';
import type { WalletManager } from '@/core/wallet.service';
import { TransactionBuilder } from '@/chain/transaction.service';
import type { ExchangeClient } from '@/exchange/cexClient/exchange.client';
import type { TradingRules } from '@/exchange/cexClient/exchange.interfaces';
import { roundQuantity, roundPrice, checkMinNotional } from '@/exchange/cexClient/exchange.utils';
import type { PricingEngine } from '@/pricing/engine/engine.service';
import { InventoryTracker } from '@/inventory/tracker/tracker.service';
import { Venue } from '@/inventory/tracker/tracker.interfaces';
import { Direction } from '@/strategy/signal.interfaces';
import type { Signal } from '@/strategy/signal.interfaces';
import type { VenueProfile } from '@/venues/venue.interfaces';
import {
  ExecutorState,
  type ExecutionContext,
  type ExecutorConfig,
  type LegResult,
} from '@/executor/engine/engine.interfaces';
import { UnwindError, StaleQuoteError, ConfigurationError } from '@/executor/engine/engine.errors';
import {
  CEX_PRICE_BUFFER_BPS,
  DEFAULT_LEG1_TIMEOUT_MS,
  DEFAULT_LEG2_TIMEOUT_MS,
  DEFAULT_MIN_FILL_RATIO,
  UNWIND_SLIPPAGE_BPS,
  DEX_SWAP_GAS_LIMIT,
} from '@/executor/engine/engine.constants';
import { CircuitBreaker, ReplayProtection } from '@/executor/recovery/recovery.service';
import {
  ROUTER_ABI,
  DEFAULT_DEADLINE_OFFSET,
  UNISWAP_V2_ROUTER,
} from '@/pricing/forkSimulator/fork.constants';
import { TRANSFER_ABI, TRANSFER_TOPIC } from '@/chain/analyzer/analyzer.constants';

const log = makeLogger('Executor');

/** Executes arbitrage signals across CEX and DEX with circuit breaking and replay protection. */
export class Executor {
  private readonly leg1TimeoutMs: number;
  private readonly leg2TimeoutMs: number;
  private readonly minFillRatio: number;
  private readonly useFlashbots: boolean;
  private readonly simulationMode: boolean;
  private readonly dexSlippageBps: bigint;
  private readonly router: Address;
  private readonly pairTokens: Map<string, readonly [Token, Token]> | undefined;
  private readonly circuitBreaker = new CircuitBreaker();
  private readonly replayProtection = new ReplayProtection();
  private readonly tradingRules: Map<string, TradingRules>;

  constructor(
    private readonly exchangeClient: ExchangeClient,
    private readonly pricingEngine: PricingEngine | null,
    private readonly inventory: InventoryTracker,
    private readonly profile: VenueProfile,
    config: ExecutorConfig = {},
    private readonly chainClient: ChainClient | null = null,
    private readonly wallet: WalletManager | null = null,
    private readonly flashbotsChainClient: ChainClient | null = null,
  ) {
    this.leg1TimeoutMs = config.leg1TimeoutMs ?? DEFAULT_LEG1_TIMEOUT_MS;
    this.leg2TimeoutMs = config.leg2TimeoutMs ?? DEFAULT_LEG2_TIMEOUT_MS;
    this.minFillRatio = config.minFillRatio ?? DEFAULT_MIN_FILL_RATIO;
    this.useFlashbots = config.useFlashbots ?? true;
    this.simulationMode = config.simulationMode ?? true;
    this.dexSlippageBps = config.dexSlippageBps ?? 50n;
    this.router = config.router ?? UNISWAP_V2_ROUTER;
    this.pairTokens = config.pairTokens;
    this.tradingRules = config.tradingRules ?? new Map();
  }

  /** True when the circuit breaker is open and execution is blocked. */
  isCircuitBreakerOpen(): boolean {
    return this.circuitBreaker.isOpen();
  }

  /** Milliseconds until the circuit breaker auto-resets; 0 when closed. */
  circuitBreakerResetMs(): number {
    return this.circuitBreaker.timeUntilResetMs();
  }

  async execute(signal: Signal): Promise<ExecutionContext> {
    const ctx = this.makeContext(signal);

    if (this.circuitBreaker.isOpen()) {
      return this.fail(ctx, 'Circuit breaker open');
    }

    if (this.replayProtection.isDuplicate(signal)) {
      return this.fail(ctx, 'Duplicate signal');
    }

    ctx.state = ExecutorState.VALIDATING;
    if (!signal.isValid()) {
      const reasons: string[] = [];
      if (Date.now() >= signal.expiry.getTime()) reasons.push('expired');
      if (!signal.inventoryOk) reasons.push('inventory insufficient at signal time');
      if (!signal.withinLimits) reasons.push('exceeds max position');
      return this.fail(ctx, `Signal invalid: ${reasons.join(', ') || 'unknown'}`);
    }

    const [base = '', quote = ''] = signal.pair.split('/');
    const quoteNeeded = (signal.size * signal.cexPrice) / PRICE_SCALE;
    const isBuyDex = signal.direction === Direction.BUY_DEX_SELL_CEX;
    const inventoryCheck = this.inventory.canExecute(
      isBuyDex ? Venue.WALLET : Venue.BINANCE,
      quote,
      quoteNeeded,
      isBuyDex ? Venue.BINANCE : Venue.WALLET,
      base,
      signal.size,
    );
    if (!inventoryCheck.canExecute) {
      return this.fail(ctx, inventoryCheck.reason ?? 'Insufficient inventory');
    }

    const result = this.useFlashbots
      ? await this.executeDexFirst(ctx)
      : await this.executeCexFirst(ctx);

    this.replayProtection.markExecuted(signal);

    if (result.state === ExecutorState.DONE) {
      this.circuitBreaker.recordSuccess();
    } else {
      this.circuitBreaker.recordFailure();
    }

    result.finishedAt = new Date();
    return result;
  }

  private async executeCexFirst(ctx: ExecutionContext): Promise<ExecutionContext> {
    const { signal } = ctx;

    ctx.state = ExecutorState.LEG1_PENDING;
    ctx.leg1Venue = 'cex';

    const leg1 = await this.withTimeout(
      this.executeCexLeg(signal, signal.size),
      this.leg1TimeoutMs,
    );
    if (!leg1) return this.fail(ctx, 'CEX timeout');
    if (!leg1.success) return this.fail(ctx, leg1.error ?? 'CEX rejected');

    const minFillScaled = BigInt(Math.round(this.minFillRatio * 10_000));
    if ((leg1.filled * 10_000n) / signal.size < minFillScaled) {
      const pct = ((Number(leg1.filled) * 100) / Number(signal.size)).toFixed(1);
      return this.fail(ctx, `Partial fill below threshold: ${pct}%`);
    }

    ctx.leg1FillPrice = leg1.price;
    ctx.leg1FillSize = leg1.filled;
    ctx.state = ExecutorState.LEG1_FILLED;

    ctx.state = ExecutorState.LEG2_PENDING;
    ctx.leg2Venue = 'dex';

    const leg2 = await this.withTimeout(
      this.executeDexLeg(signal, leg1.filled),
      this.leg2TimeoutMs,
    );
    if (!leg2) {
      ctx.state = ExecutorState.UNWINDING;
      await this.unwind(ctx).catch((e: unknown) => {
        logError(log, 'Unwind failed', {
          pair: ctx.signal.pair,
          state: ctx.state,
          cause: e instanceof Error ? e.message : String(e),
        });
      });
      return this.fail(ctx, 'DEX timeout — unwound');
    }
    if (!leg2.success) {
      ctx.state = ExecutorState.UNWINDING;
      await this.unwind(ctx).catch((e: unknown) => {
        logError(log, 'Unwind failed', {
          pair: ctx.signal.pair,
          state: ctx.state,
          cause: e instanceof Error ? e.message : String(e),
        });
      });
      return this.fail(ctx, `DEX failed — unwound: ${leg2.error ?? ''}`);
    }

    ctx.leg2FillPrice = leg2.price;
    ctx.leg2FillSize = leg2.filled;
    ctx.actualNetPnlUsd = this.calculatePnl(ctx);
    ctx.state = ExecutorState.DONE;
    this.recordTrades(ctx);
    return ctx;
  }

  private async executeDexFirst(ctx: ExecutionContext): Promise<ExecutionContext> {
    const { signal } = ctx;

    ctx.state = ExecutorState.LEG1_PENDING;
    ctx.leg1Venue = 'dex';

    const leg1 = await this.withTimeout(
      this.executeDexLeg(signal, signal.size),
      this.leg2TimeoutMs,
    );
    if (!leg1) return this.fail(ctx, 'DEX timeout');
    if (!leg1.success) return this.fail(ctx, `DEX leg failed: ${leg1.error ?? 'unknown error'}`);

    ctx.leg1FillPrice = leg1.price;
    ctx.leg1FillSize = leg1.filled;
    ctx.state = ExecutorState.LEG1_FILLED;

    ctx.state = ExecutorState.LEG2_PENDING;
    ctx.leg2Venue = 'cex';

    const leg2 = await this.withTimeout(
      this.executeCexLeg(signal, leg1.filled),
      this.leg1TimeoutMs,
    );
    if (!leg2) {
      ctx.state = ExecutorState.UNWINDING;
      await this.unwind(ctx).catch((e: unknown) => {
        logError(log, 'Unwind failed', {
          pair: ctx.signal.pair,
          state: ctx.state,
          cause: e instanceof Error ? e.message : String(e),
        });
      });
      return this.fail(ctx, 'CEX timeout after DEX — unwound');
    }
    if (!leg2.success) {
      ctx.state = ExecutorState.UNWINDING;
      await this.unwind(ctx).catch((e: unknown) => {
        logError(log, 'Unwind failed', {
          pair: ctx.signal.pair,
          state: ctx.state,
          cause: e instanceof Error ? e.message : String(e),
        });
      });
      return this.fail(ctx, `CEX failed after DEX — unwound: ${leg2.error ?? ''}`);
    }

    ctx.leg2FillPrice = leg2.price;
    ctx.leg2FillSize = leg2.filled;
    ctx.actualNetPnlUsd = this.calculatePnl(ctx);
    ctx.state = ExecutorState.DONE;
    this.recordTrades(ctx);
    return ctx;
  }

  private async executeCexLeg(signal: Signal, size: bigint): Promise<LegResult> {
    if (this.simulationMode) {
      await sleep(100);
      return { success: true, price: (signal.cexPrice * 10001n) / 10000n, filled: size };
    }

    const side = signal.direction === Direction.BUY_CEX_SELL_DEX ? 'buy' : 'sell';
    const priceRaw =
      side === 'buy'
        ? (signal.cexPrice * (10000n + CEX_PRICE_BUFFER_BPS)) / 10000n
        : (signal.cexPrice * (10000n - CEX_PRICE_BUFFER_BPS)) / 10000n;
    const rules = this.tradingRules.get(signal.pair);
    const adjustedSize = rules ? roundQuantity(size, rules.stepSize) : size;
    const adjustedPrice = rules ? roundPrice(priceRaw, rules.tickSize) : priceRaw;

    if (adjustedSize === 0n) {
      return {
        success: false,
        price: 0n,
        filled: 0n,
        error: 'Size rounded to zero (below LOT_SIZE step)',
      };
    }
    if (rules && !checkMinNotional(adjustedSize, adjustedPrice, rules.minNotional)) {
      return {
        success: false,
        price: 0n,
        filled: 0n,
        error: `Order below MIN_NOTIONAL (${rules.minNotional})`,
      };
    }

    const sizeNum = Number(adjustedSize) / PRICE_SCALE_NUM;
    const priceNum = Number(adjustedPrice) / PRICE_SCALE_NUM;

    const order = await this.exchangeClient.createLimitIocOrder(
      signal.pair,
      side,
      sizeNum,
      priceNum,
    );

    // IOC orders that partially filled have status 'canceled' but amountFilled > 0.
    // Treat as success so the fill-ratio check (not this leg) decides whether to proceed.
    return {
      success: order.amountFilled > 0n,
      price: order.avgFillPrice,
      filled: order.amountFilled,
      ...(order.amountFilled === 0n && { error: order.status }),
    };
  }

  /** Wallet must have approved Router02 to spend tokenIn before calling in real mode. */
  private async executeDexLeg(signal: Signal, size: bigint): Promise<LegResult> {
    if (this.simulationMode) {
      await sleep(500);
      return { success: true, price: (signal.dexPrice * 9998n) / 10000n, filled: size };
    }

    if (!this.pricingEngine || !this.chainClient || !this.wallet) {
      throw new ConfigurationError(
        'Real DEX execution requires pricingEngine, chainClient, and wallet in the Executor constructor',
      );
    }

    const [tokenIn, tokenOut] = this.resolvePairTokens(signal);
    const senderAddress = new Address(this.wallet.getAddress());

    // For BUY_DEX_SELL_CEX: tokenIn is quote (USDC), size is base (ARB) — convert to USDC cost.
    // For BUY_CEX_SELL_DEX: tokenIn is base (ARB), size is base — direct conversion.
    const amountInNative =
      signal.direction === Direction.BUY_DEX_SELL_CEX
        ? (size * signal.dexPrice * 10n ** BigInt(tokenIn.decimals)) / (PRICE_SCALE * PRICE_SCALE)
        : (size * 10n ** BigInt(tokenIn.decimals)) / PRICE_SCALE;

    const gasPrice = await this.chainClient.getGasPrice();
    const quote = await this.pricingEngine.getQuote(
      tokenIn,
      tokenOut,
      amountInNative,
      gasPrice.baseFee / 1_000_000_000n,
      senderAddress,
    );

    if (!quote.isValid) {
      throw new StaleQuoteError(
        `Quote invalid: simulated ${quote.simulatedOutput} diverges from expected ${quote.expectedOutput} beyond tolerance`,
      );
    }

    // Use the more conservative of the two quote sources so neither can silently widen the floor.
    const conservativeOutput =
      quote.simulatedOutput < quote.expectedOutput ? quote.simulatedOutput : quote.expectedOutput;
    const amountOutMin = (conservativeOutput * (10_000n - this.dexSlippageBps)) / 10_000n;
    const deadline = BigInt(Math.floor(Date.now() / 1000)) + DEFAULT_DEADLINE_OFFSET;

    const calldata = encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: 'swapExactTokensForTokens',
      args: [
        amountInNative,
        amountOutMin,
        [tokenIn.address.value as Hex, tokenOut.address.value as Hex],
        senderAddress.value as Hex,
        deadline,
      ],
    });

    const sendClient = this.flashbotsChainClient ?? this.chainClient;

    const receipt = await new TransactionBuilder(sendClient, this.wallet)
      .to(this.router)
      .data(Buffer.from(calldata.slice(2), 'hex'))
      .gasLimit(DEX_SWAP_GAS_LIMIT)
      .withGasPrice('medium')
      .sendAndWait(Math.ceil(this.leg2TimeoutMs / 1000));

    const amountOutNative = this.parseSwapOutput(receipt.logs, tokenOut, senderAddress);
    if (amountOutNative === 0n) {
      return {
        success: false,
        price: 0n,
        filled: 0n,
        error: `DEX swap confirmed but no Transfer log found for ${tokenOut.symbol} — output amount unknown`,
      };
    }

    const [quoteAmt, quoteDecimals, baseAmt, baseDecimals] =
      signal.direction === Direction.BUY_DEX_SELL_CEX
        ? [amountInNative, tokenIn.decimals, amountOutNative, tokenOut.decimals]
        : [amountOutNative, tokenOut.decimals, amountInNative, tokenIn.decimals];
    const price =
      baseAmt > 0n
        ? (quoteAmt * 10n ** BigInt(baseDecimals) * PRICE_SCALE) /
          (baseAmt * 10n ** BigInt(quoteDecimals))
        : 0n;

    return { success: true, price, filled: size };
  }

  private resolvePairTokens(signal: Signal): [Token, Token] {
    if (!this.pairTokens) {
      throw new ConfigurationError(
        'pairTokens not set in ExecutorConfig — required for real DEX execution',
      );
    }
    const entry = this.pairTokens.get(signal.pair);
    if (!entry) {
      throw new ConfigurationError(`No token mapping found for pair: ${signal.pair}`);
    }
    const [base, quote] = entry;
    // BUY_DEX_SELL_CEX: spend quote (e.g. USDC), receive base (e.g. WETH)
    return signal.direction === Direction.BUY_DEX_SELL_CEX ? [quote, base] : [base, quote];
  }

  private parseSwapOutput(logs: unknown[], tokenOut: Token, recipient: Address): bigint {
    for (const rawLog of [...logs].reverse()) {
      const log = rawLog as { address: string; topics: string[]; data: string };
      if (log.address.toLowerCase() !== tokenOut.address.lower) continue;
      if (log.topics[0] !== TRANSFER_TOPIC) continue;
      try {
        const { args } = decodeEventLog({
          abi: TRANSFER_ABI,
          topics: log.topics as [Hex, ...Hex[]],
          data: log.data as Hex,
        });
        if (args.to.toLowerCase() === recipient.lower) return args.value;
      } catch {
        // malformed log — skip
      }
    }
    return 0n;
  }

  private async unwind(ctx: ExecutionContext): Promise<void> {
    if (this.simulationMode) {
      await sleep(100);
      return;
    }

    const fillSize = ctx.leg1FillSize;
    if (!fillSize || fillSize === 0n) return;

    if (ctx.leg1Venue === 'dex') {
      await this.unwindDexLeg(ctx, fillSize);
      return;
    }

    const { signal } = ctx;
    const rules = this.tradingRules.get(signal.pair);
    const adjustedFill = rules ? roundQuantity(fillSize, rules.stepSize) : fillSize;
    if (adjustedFill === 0n) return;

    const sizeNum = Number(adjustedFill) / PRICE_SCALE_NUM;
    const unwindSide = signal.direction === Direction.BUY_CEX_SELL_DEX ? 'sell' : 'buy';

    try {
      await this.exchangeClient.createMarketOrder(signal.pair, unwindSide, sizeNum);
    } catch (e) {
      throw new UnwindError(
        `Market ${unwindSide} unwind failed for ${signal.pair}: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
  }

  private async unwindDexLeg(ctx: ExecutionContext, fillSize: bigint): Promise<void> {
    if (!this.chainClient || !this.wallet) {
      throw new UnwindError('DEX unwind requires chainClient and wallet — cannot reverse position');
    }

    const { signal } = ctx;
    const fillPrice = ctx.leg1FillPrice ?? 0n;

    const [tokenIn, tokenOut] = this.resolvePairTokens(signal);
    const unwindTokenIn = tokenOut;
    const unwindTokenOut = tokenIn;

    const amountInNative =
      signal.direction === Direction.BUY_DEX_SELL_CEX
        ? (fillSize * 10n ** BigInt(unwindTokenIn.decimals)) / PRICE_SCALE
        : (fillSize * fillPrice * 10n ** BigInt(unwindTokenIn.decimals)) /
          (PRICE_SCALE * PRICE_SCALE);

    if (amountInNative === 0n) return;

    const senderAddress = new Address(this.wallet.getAddress());
    const deadline = BigInt(Math.floor(Date.now() / 1000)) + DEFAULT_DEADLINE_OFFSET;

    // Floor based on fill price — accepts up to UNWIND_SLIPPAGE_BPS (5%) worse than entry.
    // This prevents a MEV sandwich from draining the position on emergency exit.
    const expectedOutNative =
      signal.direction === Direction.BUY_DEX_SELL_CEX
        ? (fillSize * fillPrice * 10n ** BigInt(unwindTokenOut.decimals)) /
          (PRICE_SCALE * PRICE_SCALE)
        : (fillSize * 10n ** BigInt(unwindTokenOut.decimals)) / PRICE_SCALE;
    const amountOutMin = (expectedOutNative * (10_000n - UNWIND_SLIPPAGE_BPS)) / 10_000n;

    const calldata = encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: 'swapExactTokensForTokens',
      args: [
        amountInNative,
        amountOutMin,
        [unwindTokenIn.address.value as Hex, unwindTokenOut.address.value as Hex],
        senderAddress.value as Hex,
        deadline,
      ],
    });

    const sendClient = this.flashbotsChainClient ?? this.chainClient;

    try {
      await new TransactionBuilder(sendClient, this.wallet)
        .to(this.router)
        .data(Buffer.from(calldata.slice(2), 'hex'))
        .gasLimit(DEX_SWAP_GAS_LIMIT)
        .withGasPrice('high')
        .sendAndWait(Math.ceil(this.leg2TimeoutMs / 1000));
    } catch (e) {
      throw new UnwindError(
        `DEX unwind swap failed for ${signal.pair}: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
  }

  private recordTrades(ctx: ExecutionContext): void {
    const { signal } = ctx;
    const [base = '', quote = ''] = signal.pair.split('/');
    const leg1Size = ctx.leg1FillSize ?? 0n;
    const leg2Size = ctx.leg2FillSize ?? 0n;
    const leg1Price = ctx.leg1FillPrice ?? 0n;
    const leg2Price = ctx.leg2FillPrice ?? 0n;
    const leg1Notional = (leg1Size * leg1Price) / PRICE_SCALE;
    const leg2Notional = (leg2Size * leg2Price) / PRICE_SCALE;
    const halfFeeBps = this.profile.trading.combinedFeeRateBps / 2n;
    const leg1Fee = (leg1Notional * halfFeeBps) / 10_000n;
    const leg2Fee = (leg2Notional * halfFeeBps) / 10_000n;

    if (ctx.leg1Venue === 'cex') {
      const cexSide = signal.direction === Direction.BUY_CEX_SELL_DEX ? 'buy' : 'sell';
      this.inventory.recordTrade(
        Venue.BINANCE,
        cexSide,
        base,
        quote,
        leg1Size,
        leg1Notional,
        leg1Fee,
        quote,
      );
      this.inventory.recordTrade(
        Venue.WALLET,
        cexSide === 'buy' ? 'sell' : 'buy',
        base,
        quote,
        leg2Size,
        leg2Notional,
        leg2Fee,
        quote,
      );
    } else {
      const dexSide = signal.direction === Direction.BUY_DEX_SELL_CEX ? 'buy' : 'sell';
      this.inventory.recordTrade(
        Venue.WALLET,
        dexSide,
        base,
        quote,
        leg1Size,
        leg1Notional,
        leg1Fee,
        quote,
      );
      this.inventory.recordTrade(
        Venue.BINANCE,
        dexSide === 'buy' ? 'sell' : 'buy',
        base,
        quote,
        leg2Size,
        leg2Notional,
        leg2Fee,
        quote,
      );
    }
  }

  private calculatePnl(ctx: ExecutionContext): bigint {
    const { signal } = ctx;
    const leg1Price = ctx.leg1FillPrice ?? 0n;
    const leg2Price = ctx.leg2FillPrice ?? 0n;
    const size = ctx.leg1FillSize ?? 0n;

    const grossScaled =
      signal.direction === Direction.BUY_CEX_SELL_DEX
        ? ((leg2Price - leg1Price) * size) / PRICE_SCALE
        : ((leg1Price - leg2Price) * size) / PRICE_SCALE;

    // Use signal's pre-computed fee estimate (includes gas + CEX + DEX fees) for consistency
    // with the signal generation model. Fill size may differ slightly from signal.size on partial fills.
    const fillRatio = signal.size > 0n ? (size * 10_000n) / signal.size : 10_000n;
    const feeScaled = (signal.expectedFees * fillRatio) / 10_000n;

    return grossScaled - feeScaled;
  }

  private async withTimeout(promise: Promise<LegResult>, ms: number): Promise<LegResult | null> {
    return Promise.race([
      promise.catch(
        (e: unknown): LegResult => ({
          success: false,
          price: 0n,
          filled: 0n,
          error: e instanceof Error ? e.message : String(e),
        }),
      ),
      sleep(ms).then(() => null),
    ]);
  }

  private makeContext(signal: Signal): ExecutionContext {
    return {
      signal,
      state: ExecutorState.IDLE,
      leg1Venue: '',
      leg1OrderId: null,
      leg1FillPrice: null,
      leg1FillSize: null,
      leg2Venue: '',
      leg2TxHash: null,
      leg2FillPrice: null,
      leg2FillSize: null,
      startedAt: new Date(),
      finishedAt: null,
      actualNetPnlUsd: null,
      error: null,
    };
  }

  private fail(ctx: ExecutionContext, error: string): ExecutionContext {
    ctx.state = ExecutorState.FAILED;
    ctx.error = error;
    return ctx;
  }
}
