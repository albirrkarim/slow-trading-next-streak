import { deepCopy } from "@/components/client/utils";
import type {
  AveragingRecommendation,
  DataBacktestPurpose,
  EntryRecommendation,
} from "@/lib/brain/algorithms/type-execute";
import { decisionEngineLevelConfig } from "@/lib/brain/algorithms/v4/decisions/utils";
import { timeMsToReadable } from "@/lib/datasets/utils";
import type {
  BacktestConfigDynamic,
  DynamicTradeMemory,
  TradeHistoryDynamic,
  VolatilityPoint,
} from "@/lib/dynamic";
import { TradingMode } from "@/lib/exchange";
import { getCurrentExchangeAccountSlug } from "@/lib/exchange/account-context";
import {
  adjustEntryMarginForSlowConfig,
  buildSlowWatchReserveState,
  canSpendWatchStepMargin,
  getSpendableQuoteAssetValue,
  hasPositionHitTargetVolatilityPoint,
  isActionableAveragingVolatilityLevel,
  isEntrySignalVolatilityPointUsed,
  getNextWatchStep,
  getReservedRemainingUsdt,
  markEntrySignalVolatilityPointUsed,
  markReservedWatchStepUsed,
  resolveAveragingRescueProjection,
  roundUsdt,
} from "@/lib/slowTrading/watch-reserve";
import { MINIMAL_USDT_TO_TRADE } from "@/lib/trading/constants";
import averagingMessage from "@/lib/trading/execute/averaging-message";
import entryFunding from "@/lib/trading/execute/entry-funding";
import { resolveEntryLeverage } from "@/lib/trading/execute/entry-leverage";
import entryOpenPositionGuard from "@/lib/trading/execute/entry-open-position-guard";
import { tradeLog } from "@/lib/trading/helper/log";
import { TRADE_MESSAGE } from "@/lib/trading/message";
import type {
  Position,
  PositionRole,
  TradingModelMemory,
} from "@/lib/trading/models";
import bothDirection from "@/lib/trading/both-direction";
import streakBreak from "@/lib/trading/streak-break";
import { resolveBacktestFeeRatio } from "./constants";

const DAY_MS = 24 * 60 * 60 * 1000;

interface BacktestTradeRuntimeProps {
  currentTimeMs: number;
  modelMemoryMap: Record<string, TradingModelMemory>;
  dynamicTradeMemory: DynamicTradeMemory;
  backtestPack: DataBacktestPurpose;
  config: BacktestConfigDynamic;
  volume24hBySymbol?: Record<string, number>;
}

export function getBacktestSpendableQuoteAsset(
  dynamicTradeMemory: DynamicTradeMemory,
): number {
  return getSpendableQuoteAssetValue({
    quoteAsset: dynamicTradeMemory.quoteAsset,
    reservedQuoteAsset: dynamicTradeMemory.reservedQuoteAsset,
  });
}

function addBacktestReservedQuoteAsset(
  dynamicTradeMemory: DynamicTradeMemory,
  amount: number,
) {
  if (!Number.isFinite(amount) || amount <= 0) {
    return;
  }

  dynamicTradeMemory.reservedQuoteAsset = roundUsdt(
    (dynamicTradeMemory.reservedQuoteAsset ?? 0) + amount,
  );
}

export function subtractBacktestReservedQuoteAsset(
  dynamicTradeMemory: DynamicTradeMemory,
  amount: number,
) {
  if (!Number.isFinite(amount) || amount <= 0) {
    return;
  }

  dynamicTradeMemory.reservedQuoteAsset = roundUsdt(
    Math.max(0, (dynamicTradeMemory.reservedQuoteAsset ?? 0) - amount),
  );
}

export function fitBacktestEntryMargin(params: {
  desiredMarginUsdt: number;
  spendableUsdt: number;
  config: BacktestConfigDynamic;
  volume24h?: number;
}): number {
  const { config } = params;
  return Math.floor(
    adjustEntryMarginForSlowConfig({
      desiredMarginUsdt: params.desiredMarginUsdt,
      spendableUsdt: params.spendableUsdt,
      enableWatchLogic: config.enableWatchLogic !== false,
      reserveLevels: config.watchReserveLevels ?? 2,
      pctAlloc: config.watchReservePctAlloc ?? 2,
      maxEntryBased24HourVolPct: config.maxEntryBased24HourVolPct ?? 0.2,
      volume24h: params.volume24h,
      maxEntryMarginPct: config.maxEntryMarginPct ?? 0,
      maxEntryMargin: config.maxEntryMargin ?? 0,
    }),
  );
}

function estimateVolume24hFromVolatilityPoints({
  currentTimeMs,
  points,
}: {
  currentTimeMs: number;
  points: VolatilityPoint[];
}) {
  const cutoff = currentTimeMs - DAY_MS;
  const volume = points.reduce((total, point) => {
    if (point.t < cutoff || point.t > currentTimeMs) return total;
    return Number.isFinite(point.vq) && point.vq > 0 ? total + point.vq : total;
  }, 0);

  return volume > 0 ? volume : undefined;
}

function buildBacktestStrategy(params: {
  recommend: EntryRecommendation;
  direction: "LONG" | "SHORT";
  marginUsdt: number;
  config: BacktestConfigDynamic;
}) {
  const { recommend, direction, marginUsdt, config } = params;
  const baseFeature =
    recommend.feature && typeof recommend.feature === "object"
      ? deepCopy(recommend.feature)
      : {};

  const averaging =
    config.enableWatchLogic === false
      ? {
          entryLevel: recommend.lvl ?? 0,
          lastHandledLevel: recommend.lvl ?? 0,
          reserveBaseMarginUsdt: marginUsdt,
          reservedRemainingMarginUsdt: 0,
          steps: [],
        }
      : buildSlowWatchReserveState({
          direction,
          baseMarginUsdt: marginUsdt,
          entryLevel: recommend.lvl ?? 0,
          reserveLevels: config.watchReserveLevels ?? 2,
          maxNextLevels:
            config.watchMaxNextAveragingLevels ??
            config.watchReserveLevels ??
            2,
          pctAlloc: config.watchReservePctAlloc ?? 2,
        });

  return {
    entry: {
      feature: Object.keys(baseFeature).length > 0 ? baseFeature : undefined,
      label: recommend.descisionLabel,
    },
    averaging,
  };
}

export function tryOpenBacktestEntry({
  currentTimeMs,
  modelMemoryMap,
  dynamicTradeMemory,
  backtestPack,
  config,
  pairLeg,
  recommend,
  volume24hBySymbol,
}: BacktestTradeRuntimeProps & {
  pairLeg?: {
    direction: Position["direction"];
    entryLegs?: Position["entryLegs"];
    pairId: string;
    role: PositionRole;
  };
  recommend: EntryRecommendation;
}): boolean {
  const symbol = recommend.symbol ?? "";
  const modelMemory = modelMemoryMap[symbol];
  if (!symbol || !modelMemory) {
    return false;
  }

  const activePositions = Object.values(modelMemoryMap).flatMap(
    (memory) => (memory.positions ?? []).filter((position) => !position.closed),
  );
  const openPositionGuard = entryOpenPositionGuard.evaluate({
    maxOpenPositions: config.maxOpenPositions,
    positions: activePositions,
  });

  // BOTH:MAX_OPEN_POSITIONS_ENTRY_GUARD
  if (openPositionGuard.blocked && !pairLeg) {
    return false;
  }

  if (!pairLeg && (modelMemory.positions?.length ?? 0) > 0) {
    // BOTH:ONLY_ONE_ACTIVE_POSITION_PER_COIN
    return false;
  }

  if (
    !decisionEngineLevelConfig.isEntryLevel(
      recommend,
      config.minAbsLevelToEntry,
      config.maxAbsLevelToEntry,
    )
  ) {
    return false;
  }

  if (
    isEntrySignalVolatilityPointUsed({
      entrySignal: recommend,
      modelMemory,
      roles: pairLeg
        ? [pairLeg.role]
        : bothDirection.entry.resolveRoles(config),
    })
  ) {
    // BOTH:ENTRY_ONLY_IN_UNIQUE_VOLATILITY_POINT_ID
    return false;
  }

  if (recommend.l === "T" && config.tradingMode === TradingMode.SPOT) {
    return false;
  }

  const direction =
    pairLeg?.direction ?? (recommend.l === "B" ? "LONG" : "SHORT");
  const legs = pairLeg
    ? [pairLeg]
    : bothDirection.entry.resolveLegs({
        entryLegs: config.entryLegs,
        mainDirection: direction,
        openDirection: config.openDirection,
      });
  const pairId =
    pairLeg?.pairId ??
    (bothDirection.config.isEnabled(config.openDirection)
      ? bothDirection.entry.pairId.build({
          symbol,
          opened: {
            t: recommend.t,
            vPoint: { id: recommend.id },
          },
        })
      : undefined);
  const leverage = resolveEntryLeverage({
    entrySignal: recommend,
    tradingMode: config.tradingMode,
    config,
  });
  const entryFeeRates = legs.map((leg) =>
    resolveBacktestFeeRatio({
      exchangeType: config.exchangeType,
      side: leg.direction === "SHORT" ? "sell" : "buy",
    }),
  );
  const fundingFeeRate = Math.max(...entryFeeRates);
  const fundingPlan = entryFunding.plan.calculate({
    activePositions,
    config,
    direction,
    entryLevel: recommend.lvl ?? 0,
    feeRate: fundingFeeRate,
    leverage,
    requestedMarginUsdt: recommend.investAmount ?? 0,
    reservedQuoteAsset: dynamicTradeMemory.reservedQuoteAsset ?? 0,
    spendableQuoteAsset: dynamicTradeMemory.quoteAsset,
    tradingMode: config.tradingMode,
    volume24h:
      volume24hBySymbol?.[symbol] ??
      estimateVolume24hFromVolatilityPoints({
        currentTimeMs,
        points: modelMemory.volatility?.lastVolatility ?? [],
      }),
    workerLegs: legs.length,
  });

  if (fundingPlan.blockReason) {
    return false;
  }

  const notionalUsdt = fundingPlan.availableNotionalUsdt;
  const marginUsdt =
    config.tradingMode === TradingMode.SPOT
      ? notionalUsdt
      : notionalUsdt / leverage;
  if (marginUsdt < MINIMAL_USDT_TO_TRADE) {
    return false;
  }

  const positionsBefore = deepCopy(modelMemory.positions);
  const strategy = buildBacktestStrategy({
    recommend,
    direction,
    marginUsdt,
    config,
  });
  const reservedUsdt = getReservedRemainingUsdt(strategy.averaging);
  const message =
    `${TRADE_MESSAGE.buy.ENTRY} ${symbol} LVL ${recommend.lvl} ${direction} ` +
    `${timeMsToReadable(currentTimeMs)} USDT: ${marginUsdt.toFixed(2)} ${recommend.id}`;
  const entryMessage = recommend.message ?? message;

  const positions = legs.map<Position>((leg, index) => {
    const entryFeeUsdt = notionalUsdt * entryFeeRates[index];
    return {
      // BOTH:MULTI_ACCOUNT_POSITION_OWNER
      account: getCurrentExchangeAccountSlug(),
      symbol,
      pairId,
      role: leg.role,
      entryLegs: bothDirection.config.isEnabled(config.openDirection)
        ? (pairLeg?.entryLegs ??
          bothDirection.entry.normalizeSelection(config.entryLegs))
        : undefined,
      executionMode: "sandbox",
      tradingMode: config.tradingMode,
      direction: leg.direction,
      opened: {
        t: recommend.t,
        vPoint: { id: recommend.id, lvl: recommend.lvl ?? 0, t: recommend.t },
        reason: "COMMON",
        message: entryMessage,
        price: recommend.p,
      },
      exposure: {
        averageEntryPrice: recommend.p,
        quantity: notionalUsdt / recommend.p,
        notionalUsdt,
        marginUsdt,
        leverage,
      },
      fees: {
        entryUsdt: entryFeeUsdt,
        estimatedExitUsdt: entryFeeUsdt,
      },
      strategy: buildBacktestStrategy({
        recommend,
        direction: leg.direction,
        marginUsdt,
        config,
      }),
      pnl: {},
    };
  });
  if (pairLeg) {
    streakBreak.pending.clear({
      memory: modelMemory,
      pairId: pairLeg.pairId,
      role: pairLeg.role,
    });
  }
  modelMemory.positions.push(...positions);

  backtestPack.tradeHistoryMap[symbol].push({
    time: currentTimeMs,
    side: direction === "LONG" ? "BUY" : "SELL",
    price: recommend.p,
    fee: positions.reduce(
      (total, position) => total + position.fees.entryUsdt,
      0,
    ),
    tax: 0,
    positionsBefore,
    positionsAfter: deepCopy(modelMemory.positions),
    message: entryMessage,
    profit: 0,
  } as TradeHistoryDynamic);

  dynamicTradeMemory.quoteAsset = roundUsdt(
    dynamicTradeMemory.quoteAsset -
      positions.reduce(
        (total, position) =>
          total + position.exposure.marginUsdt + position.fees.entryUsdt,
        0,
      ),
  );
  addBacktestReservedQuoteAsset(
    dynamicTradeMemory,
    positions.reduce(
      (sum, position) =>
        sum + getReservedRemainingUsdt(position.strategy.averaging),
      0,
    ),
  );
  markEntrySignalVolatilityPointUsed({
    entrySignal: recommend,
    modelMemory,
    roles: pairLeg
      ? [pairLeg.role]
      : bothDirection.entry.resolveRoles(config),
  });

  tradeLog.log("\n\n");
  tradeLog.log(
    `${message} | reserved: ${reservedUsdt.toFixed(2)} | quote: ${dynamicTradeMemory.quoteAsset.toFixed(2)} | spendable: ${getBacktestSpendableQuoteAsset(dynamicTradeMemory).toFixed(2)}`,
  );

  return true;
}

/** Reopens one missing BOTH role after its directional target has formed. */
export function tryOpenBacktestStreakReentry(
  params: BacktestTradeRuntimeProps & {
    symbol: string;
    volatilityPoints: VolatilityPoint[];
  },
): boolean {
  const modelMemory = params.modelMemoryMap[params.symbol];
  if (!modelMemory) {
    return false;
  }

  const decision = streakBreak.reentry.resolve({
    positions: modelMemory.positions ?? [],
    pendingReentries: modelMemory.pendingReentries,
    volatilityPoints: params.volatilityPoints,
  });
  if (decision?.status !== "READY" || !decision.point) {
    return false;
  }

  decision.survivor.pairId = decision.pairId;
  return tryOpenBacktestEntry({
    ...params,
    pairLeg: {
      direction: decision.direction,
      entryLegs: decision.survivor.entryLegs,
      pairId: decision.pairId,
      role: decision.role,
    },
    recommend: {
      ...decision.point,
      amountProbab: decision.point.probability ?? 1,
      maxLeverage: decision.survivor.exposure.leverage,
      message: decision.reason,
      symbol: params.symbol,
    },
  });
}

export function tryExecuteBacktestAveraging({
  currentTimeMs,
  modelMemoryMap,
  dynamicTradeMemory,
  backtestPack,
  config,
  recommend,
  volatilityPoints,
}: BacktestTradeRuntimeProps & {
  recommend: AveragingRecommendation;
  volatilityPoints: VolatilityPoint[];
}): boolean {
  const symbol = recommend.symbol ?? "";
  const modelMemory = modelMemoryMap[symbol];
  const position = modelMemory?.positions?.find((candidate) => {
    if (candidate.closed) return false;
    const entryLevel = candidate.opened.vPoint.lvl;
    return candidate.direction === "LONG"
      ? (recommend.lvl ?? entryLevel) < entryLevel
      : (recommend.lvl ?? entryLevel) > entryLevel;
  });

  if (!symbol || !modelMemory || !position) {
    return false;
  }

  if (
    hasPositionHitTargetVolatilityPoint({
      directional: bothDirection.pair.isLeg(position, [
        ...(modelMemory.positions ?? []),
        ...(modelMemory.positionsSell ?? []),
      ]),
      position,
      volatilityPoints,
    })
  ) {
    // BOTH:AVERAGING_STOPS_AFTER_TARGET_VPOINT
    return false;
  }

  const nextStep = getNextWatchStep({
    averaging: position.strategy.averaging,
    includeUnreserved: true,
  });

  if (!nextStep) {
    return false;
  }

  if (
    !isActionableAveragingVolatilityLevel(recommend, {
      nextStepLevel: nextStep.level,
      pairPositions: [
        ...(modelMemory.positions ?? []),
        ...(modelMemory.positionsSell ?? []),
      ],
      position,
    })
  ) {
    // PROD:LOW_LEVEL_NO_ACTION_AVERAGING
    return false;
  }

  const price = recommend.p;
  const rescueProjection = resolveAveragingRescueProjection({
    position,
    step: nextStep,
    executablePrice: price,
    rescueAnchorPrice: recommend.p,
    quoteAsset: dynamicTradeMemory.quoteAsset,
    reservedQuoteAsset: dynamicTradeMemory.reservedQuoteAsset,
    adaptiveAveraging: config.adaptiveAveraging,
    rescueProjectionGuardEnabled:
      config.averagingRescueProjectionGuardEnabled !== false,
    triggerVolatilityPct: recommend.pct,
  });

  if (!rescueProjection.canExecute) {
    // BOTH:AVERAGING_IMPROVES_RESCUE_PROJECTION
    return false;
  }

  const marginUsdt = rescueProjection.marginUsdt;
  const leverage = position.exposure.leverage ?? recommend.maxLeverage ?? 1;
  const feeRate = resolveBacktestFeeRatio({
    exchangeType: config.exchangeType,
    side: position.direction === "SHORT" ? "sell" : "buy",
  });
  const addedNotionalUsdt = marginUsdt * leverage;
  const feeUsdt = addedNotionalUsdt * feeRate;
  const usedPctAlloc = rescueProjection.multiplier;
  const spendStep = {
    ...nextStep,
    reservedMarginUsdt: nextStep.marginUsdt,
    marginUsdt,
    allocationPct: usedPctAlloc,
  };
  const adaptiveMessageSuffix =
    usedPctAlloc !== nextStep.allocationPct
      ? ` | ADAPTIVE AVG ${usedPctAlloc}x (reserved $${nextStep.marginUsdt.toFixed(2)} -> used $${marginUsdt.toFixed(2)}, projected +${rescueProjection.projectedProfitPct.toFixed(2)}%)`
      : "";

  if (
    !canSpendWatchStepMargin({
      // BOTH:HAVE_ENOUGH_TO_RESERVED
      step: spendStep,
      quoteAsset: dynamicTradeMemory.quoteAsset,
      reservedQuoteAsset: dynamicTradeMemory.reservedQuoteAsset,
      minimalUsdt: MINIMAL_USDT_TO_TRADE,
    })
  ) {
    return false;
  }

  const spendableUsdt = getBacktestSpendableQuoteAsset(dynamicTradeMemory);
  const spendableRequiredUsdt =
    feeUsdt + (nextStep.status === "UNRESERVED" ? marginUsdt : 0);
  if (
    dynamicTradeMemory.quoteAsset < marginUsdt + feeUsdt ||
    spendableUsdt < spendableRequiredUsdt
  ) {
    return false;
  }

  const executionTimeMs = recommend.t ?? currentTimeMs;
  const addedQuantity = addedNotionalUsdt / price;
  const newQuantity = position.exposure.quantity + addedQuantity;
  const positionsBefore = deepCopy(modelMemory.positions);
  const reservedBefore = getReservedRemainingUsdt(position.strategy.averaging);

  position.exposure.averageEntryPrice =
    (position.exposure.averageEntryPrice * position.exposure.quantity +
      price * addedQuantity) /
    newQuantity;
  position.exposure.quantity = newQuantity;
  position.exposure.notionalUsdt = roundUsdt(
    (position.exposure.notionalUsdt ?? 0) + marginUsdt * leverage,
  );
  position.exposure.marginUsdt = roundUsdt(
    (position.exposure.marginUsdt ?? 0) + marginUsdt,
  );
  position.fees.entryUsdt = roundUsdt(position.fees.entryUsdt + feeUsdt);
  position.fees.estimatedExitUsdt = roundUsdt(
    position.exposure.notionalUsdt * feeRate,
  );
  const averagingSummary = averagingMessage.format({
    adaptiveMessageSuffix,
    marginUsdt,
    stepLevel: recommend.lvl ?? nextStep.level,
  });
  position.strategy.averaging.executions ??= [];
  position.strategy.averaging.executions.push({
    t: executionTimeMs,
    vPointId: recommend.id,
    vPointPrice: recommend.p,
    level: recommend.lvl ?? nextStep.level,
    marginUsdt,
    allocationPct: usedPctAlloc,
    adaptiveMultiplier:
      config.adaptiveAveraging?.enabled === true
        ? rescueProjection.multiplier
        : undefined,
    projectedProfitPct:
      config.adaptiveAveraging?.enabled === true
        ? rescueProjection.projectedProfitPct
        : undefined,
    reservedMarginUsdt: nextStep.marginUsdt,
    price,
  });

  markReservedWatchStepUsed({
    averaging: position.strategy.averaging,
    handledLevel: nextStep.level,
    executedLevel: recommend.lvl,
    executedPrice: price,
    usedAt: executionTimeMs,
    usedMarginUsdt: marginUsdt,
    usedPctAlloc,
  });

  const reservedAfter = getReservedRemainingUsdt(position.strategy.averaging);
  subtractBacktestReservedQuoteAsset(
    dynamicTradeMemory,
    Math.max(0, reservedBefore - reservedAfter),
  );
  dynamicTradeMemory.quoteAsset = roundUsdt(
    dynamicTradeMemory.quoteAsset - marginUsdt - feeUsdt,
  );

  backtestPack.tradeHistoryMap[symbol].push({
    time: executionTimeMs,
    side: position.direction === "SHORT" ? "SELL" : "BUY",
    price,
    fee: feeUsdt,
    tax: 0,
    positionsBefore,
    positionsAfter: deepCopy(modelMemory.positions),
    message:
      `${TRADE_MESSAGE.buy.ADD_POSITION} ${symbol} ${position.direction} ` +
      `| ${averagingSummary}`,
    profit: 0,
  } as TradeHistoryDynamic);

  tradeLog.log("\n\n");
  tradeLog.log(
    `${TRADE_MESSAGE.buy.ADD_POSITION} ${symbol} ${position.direction} | ${averagingSummary} | reservedRemaining: ${reservedAfter.toFixed(2)} | quote: ${dynamicTradeMemory.quoteAsset.toFixed(2)} | spendable: ${getBacktestSpendableQuoteAsset(dynamicTradeMemory).toFixed(2)}`,
  );

  return true;
}
