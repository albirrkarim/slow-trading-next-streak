import type { EntryRecommendation } from "@/lib/brain/algorithms/type-execute";
import type { AdaptiveAveragingConfig, OpenDirection } from "@/lib/dynamic";
import type { TradingMode } from "@/lib/exchange/types";
import slowTradingClient, {
  type SlowTradingDashboardState,
} from "@/lib/slowTrading/client";
import { resolveEntryLeverage } from "@/lib/trading/execute/entry-leverage";
import type { TradingModelConfig } from "@/lib/trading/models";
import postAverageStopLoss from "@/lib/trading/post-average-stop-loss";

export interface TradingLivePreviewConfig {
  adaptiveAveraging?: AdaptiveAveragingConfig;
  enableWatchLogic?: boolean;
  exactLeverage?: number;
  maxEntryMargin?: number;
  maxEntryMarginPct?: number;
  maxOpenPositions?: number;
  maxLeverage?: number;
  minAbsLevelToEntry?: number;
  modelConfig: TradingModelConfig;
  openDirection?: OpenDirection;
  tradingMode: TradingMode;
  watchMaxNextAveragingLevels?: number;
  watchReserveLevels?: number;
  watchReservePctAlloc?: number;
}

export interface TradingLivePreviewBailoutCandidate {
  level: number | null;
  marginUsdt: number;
  symbol: string;
}

export interface TradingLivePreviewFirstStopLoss {
  closesOtherLeg: boolean;
  estimatedLossUsdt: number;
  type: "HARD_STOP_PERCENT" | "NET_USDT" | "POST_AVERAGE";
}

export interface TradingLivePreviewPostAverageStopLoss {
  estimatedPercentLossUsdt: number | null;
  maxNetPnlPct: number;
  maxNetPnlUsdt: number;
  usdtEquivalentPct: number | null;
}

export interface TradingLivePreviewExitStage {
  averagingStepsUsed: number;
  counterExitMovePct: number;
  counterMarginUsdt: number;
  counterNotionalUsdt: number;
  cumulativeMarginUsdt: number;
  estimatedCounterProfitUsdt: number;
  firstStopLoss: TradingLivePreviewFirstStopLoss | null;
  estimatedLossUsdt: number | null;
  estimatedNetLossUsdt: number | null;
  estimatedNotionalUsdt: number;
  estimatedProfitUsdt: number;
  postAverageStopLoss: TradingLivePreviewPostAverageStopLoss | null;
  stopLossUSDTEquivalentPct: number | null;
  estimatedTargetZoneLossUsdt: number | null;
  marginPartsUsdt: number[];
  stage: number;
  volatilityThresholdPct: number;
}

export interface TradingLivePreviewAveragingSimulation {
  addMarginUsdt: number;
  adversePrice: number;
  averageEntryPrice: number;
  entryPrice: number;
  maxAdversePct: number | null;
  projectedProfitPct: number | null;
  requiredProfitPct: number;
  reserveMultiplier: number;
  targetMovePct: number;
  targetPrice: number | null;
}

export interface TradingLivePreviewData {
  averagingSimulation: TradingLivePreviewAveragingSimulation | null;
  availableWorkers: number;
  balanceAvailableWorkers: number;
  bailoutCandidates: TradingLivePreviewBailoutCandidate[];
  bailoutBufferUsdt: number;
  entryBudgetUsdt: number;
  entryMarginUsdt: number;
  exitStages: TradingLivePreviewExitStage[];
  leverage: number;
  currentOpenPositions: number;
  maxOpenPositions: number;
  projectedBailoutLevel: number | null;
  projectedBailoutMultiplier: number | null;
  projectedBailoutPartsUsdt: number[];
  projectedBailoutUsdt: number;
  reserveBudgetUsdt: number;
  reserveStepsUsdt: number[];
  remainingPositionSlots: number | null;
  spendableUsdt: number;
  stopLossPct: number | null;
  stopLossUSDT: number | null;
  takeProfitPct: number;
  targetZoneStopLossPct: number | null;
  workerCostUsdt: number;
  workerLegs: number;
}

const NORMALIZED_ENTRY_PRICE = 100;
const MAX_SIMULATED_ADVERSE_PCT = 99;
const PROJECTED_PROFIT_EPSILON = 1e-9;

/** Resolves the first unconditional PnL stop using the live exit check order. */
function resolveFirstStopLoss(params: {
  estimatedHardStopLossUsdt: number | null;
  estimatedPairHardStopLossUsdt: number | null;
  hasCounterLeg: boolean;
  netUsdtStopLossUsdt: number | null;
  postAveragePairLossUsdt: number | null;
  postAverageStopLossUsdt: number | null;
}): TradingLivePreviewFirstStopLoss | null {
  const {
    estimatedHardStopLossUsdt,
    estimatedPairHardStopLossUsdt,
    hasCounterLeg,
    netUsdtStopLossUsdt,
    postAveragePairLossUsdt,
    postAverageStopLossUsdt,
  } = params;

  if (
    netUsdtStopLossUsdt !== null &&
    (estimatedHardStopLossUsdt === null ||
      netUsdtStopLossUsdt <= estimatedHardStopLossUsdt)
  ) {
    const firstStopLoss: TradingLivePreviewFirstStopLoss = {
      closesOtherLeg: false,
      estimatedLossUsdt: netUsdtStopLossUsdt,
      type: "NET_USDT",
    };

    if (
      postAverageStopLossUsdt !== null &&
      postAverageStopLossUsdt < netUsdtStopLossUsdt
    ) {
      return {
        closesOtherLeg: hasCounterLeg,
        estimatedLossUsdt:
          postAveragePairLossUsdt ?? postAverageStopLossUsdt,
        type: "POST_AVERAGE",
      };
    }

    return firstStopLoss;
  }

  if (estimatedHardStopLossUsdt === null) {
    return postAverageStopLossUsdt === null
      ? null
      : {
          closesOtherLeg: hasCounterLeg,
          estimatedLossUsdt:
            postAveragePairLossUsdt ?? postAverageStopLossUsdt,
          type: "POST_AVERAGE",
        };
  }

  const firstStopLoss: TradingLivePreviewFirstStopLoss = {
    closesOtherLeg: hasCounterLeg,
    estimatedLossUsdt:
      estimatedPairHardStopLossUsdt ?? estimatedHardStopLossUsdt,
    type: "HARD_STOP_PERCENT",
  };

  if (
    postAverageStopLossUsdt !== null &&
    postAverageStopLossUsdt < estimatedHardStopLossUsdt
  ) {
    return {
      closesOtherLeg: hasCounterLeg,
      estimatedLossUsdt:
        postAveragePairLossUsdt ?? postAverageStopLossUsdt,
      type: "POST_AVERAGE",
    };
  }

  return firstStopLoss;
}

/**
 * Finds the largest adverse LONG move whose vPoint-anchored rebound still
 * reaches the configured projected-profit requirement after averaging.
 */
export function buildTradingLivePreviewAveragingSimulation(params: {
  entryMarginUsdt: number;
  leverage: number;
  requiredProfitPct: number;
  reserveMultiplier: number;
  targetMovePct: number;
}): TradingLivePreviewAveragingSimulation | null {
  const {
    entryMarginUsdt,
    leverage,
    requiredProfitPct,
    reserveMultiplier,
    targetMovePct,
  } = params;

  if (
    !Number.isFinite(entryMarginUsdt) ||
    entryMarginUsdt <= 0 ||
    !Number.isFinite(leverage) ||
    leverage <= 0 ||
    !Number.isFinite(requiredProfitPct) ||
    requiredProfitPct < 0 ||
    !Number.isFinite(reserveMultiplier) ||
    reserveMultiplier <= 0 ||
    !Number.isFinite(targetMovePct) ||
    targetMovePct <= 0
  ) {
    return null;
  }

  const existingQuantity =
    (entryMarginUsdt * leverage) / NORMALIZED_ENTRY_PRICE;
  const addMarginUsdt = entryMarginUsdt * reserveMultiplier;
  const calculateAtAdversePct = (adversePct: number) => {
    const adversePrice =
      NORMALIZED_ENTRY_PRICE * (1 - adversePct / 100);

    return slowTradingClient.watchReserve.averaging.calculateProjectedProfitPct({
      addMarginUsdt,
      direction: "LONG",
      entryPrice: NORMALIZED_ENTRY_PRICE,
      executablePrice: adversePrice,
      existingQuantity,
      leverage,
      rescueAnchorPrice: adversePrice,
      targetMovePct,
    });
  };
  const initialProjectedProfitPct = calculateAtAdversePct(0);

  if (
    initialProjectedProfitPct + PROJECTED_PROFIT_EPSILON <
    requiredProfitPct
  ) {
    return {
      addMarginUsdt,
      adversePrice: NORMALIZED_ENTRY_PRICE,
      averageEntryPrice: NORMALIZED_ENTRY_PRICE,
      entryPrice: NORMALIZED_ENTRY_PRICE,
      maxAdversePct: null,
      projectedProfitPct: null,
      requiredProfitPct,
      reserveMultiplier,
      targetMovePct,
      targetPrice: null,
    };
  }

  let lowerAdversePct = 0;
  let upperAdversePct = MAX_SIMULATED_ADVERSE_PCT;

  if (
    calculateAtAdversePct(upperAdversePct) + PROJECTED_PROFIT_EPSILON <
    requiredProfitPct
  ) {
    for (let iteration = 0; iteration < 80; iteration += 1) {
      const candidateAdversePct =
        (lowerAdversePct + upperAdversePct) / 2;

      if (
        calculateAtAdversePct(candidateAdversePct) +
          PROJECTED_PROFIT_EPSILON >=
        requiredProfitPct
      ) {
        lowerAdversePct = candidateAdversePct;
      } else {
        upperAdversePct = candidateAdversePct;
      }
    }
  } else {
    lowerAdversePct = upperAdversePct;
  }

  const maxAdversePct = lowerAdversePct;
  const adversePrice =
    NORMALIZED_ENTRY_PRICE * (1 - maxAdversePct / 100);
  const addedQuantity = (addMarginUsdt * leverage) / adversePrice;
  const averageEntryPrice =
    (NORMALIZED_ENTRY_PRICE * existingQuantity +
      adversePrice * addedQuantity) /
    (existingQuantity + addedQuantity);
  const targetPrice = adversePrice * (1 + targetMovePct / 100);

  return {
    addMarginUsdt,
    adversePrice,
    averageEntryPrice,
    entryPrice: NORMALIZED_ENTRY_PRICE,
    maxAdversePct,
    projectedProfitPct: calculateAtAdversePct(maxAdversePct),
    requiredProfitPct,
    reserveMultiplier,
    targetMovePct,
    targetPrice,
  };
}

/**
 * Builds a live per-worker entry and exit estimate from dashboard state and
 * either saved or unsaved trading configuration.
 */
export function buildTradingLivePreview(params: {
  config: TradingLivePreviewConfig;
  dashboardState: SlowTradingDashboardState;
  spendableAssumptionUsdt?: number;
}): TradingLivePreviewData {
  const { config, dashboardState } = params;
  const liveSpendableUsdt = Math.max(
    0,
    dashboardState.balances.spendableQuoteAsset,
  );
  const spendableUsdt =
    Number.isFinite(params.spendableAssumptionUsdt) &&
    params.spendableAssumptionUsdt !== undefined
      ? Math.max(0, params.spendableAssumptionUsdt)
      : liveSpendableUsdt;
  const capacity = slowTradingClient.workerCapacity.calculate({
    activePositions: dashboardState.openPositions,
    config,
    spendableUsdt,
  });
  const bailoutCandidates = dashboardState.openPositions.flatMap(
    (position, positionIndex): TradingLivePreviewBailoutCandidate[] => {
      if (position.closed) {
        return [];
      }
      const largestStep = (
        position.strategy.averaging.steps
      ).reduce(
        (
          largest:
            | { level?: number; marginUsdt: number; status: string }
            | undefined,
          step: { level?: number; marginUsdt: number; status: string },
        ) => {
          if (
            step.status !== "UNRESERVED" ||
            !Number.isFinite(step.marginUsdt) ||
            step.marginUsdt <= 0
          ) {
            return largest;
          }

          return !largest || step.marginUsdt > largest.marginUsdt
            ? step
            : largest;
        },
        undefined,
      );

      if (!largestStep) {
        return [];
      }

      return [
        {
          level: Number.isFinite(largestStep.level)
            ? Number(largestStep.level)
            : null,
          marginUsdt: largestStep.marginUsdt,
          symbol: position.symbol || `Position ${positionIndex + 1}`,
        },
      ];
    },
  );
  const leverage = resolveEntryLeverage({
    config,
    tradingMode: config.tradingMode,
    entrySignal: {
      amountProbab: 1,
      id: "settings-preview",
      l: "B",
      lvl: config.minAbsLevelToEntry ?? 2,
      maxLeverage: 2,
      message: "Trading settings preview",
      p: 1,
      t: 0,
    } as EntryRecommendation,
  });
  const takeProfitPct = Math.max(
    0,
    Number(config.modelConfig.takeProfitPercent) || 0,
  );
  const configuredStopLossPct = Number(
    config.modelConfig.stopLossPercent,
  );
  const stopLossPct =
    Number.isFinite(configuredStopLossPct) && configuredStopLossPct > 0
      ? configuredStopLossPct
      : null;
  const configuredStopLossUSDT = Number(config.modelConfig.stopLossUSDT ?? 50);
  const stopLossUSDT =
    Number.isFinite(configuredStopLossUSDT) && configuredStopLossUSDT > 0
      ? configuredStopLossUSDT
      : null;
  const configuredTargetZoneStopLossPct = Number(
    config.modelConfig.volatilityTargetStopLossPercent,
  );
  const targetZoneStopLossPct =
    Number.isFinite(configuredTargetZoneStopLossPct) &&
    configuredTargetZoneStopLossPct > 0
      ? configuredTargetZoneStopLossPct
      : null;
  const reserveLevels =
    config.enableWatchLogic === false
      ? 0
      : Math.max(0, Math.floor(config.watchReserveLevels ?? 2));
  const maxNextAveragingLevels =
    config.enableWatchLogic === false
      ? 0
      : Math.max(
          0,
          Math.floor(
            config.watchMaxNextAveragingLevels ?? reserveLevels,
          ),
        );
  const pctAlloc = config.watchReservePctAlloc ?? 2;
  const volatilityThresholdPct = Math.max(
    0,
    Number(dashboardState.globalConfig?.volatilityThresholdPct) || 0,
  );
  const configuredMinimumProjectedProfitPct = Number(
    config.adaptiveAveraging?.minProjectedProfitPct,
  );
  const requiredProjectedProfitPct =
    Number.isFinite(configuredMinimumProjectedProfitPct) &&
    configuredMinimumProjectedProfitPct >= 0
      ? configuredMinimumProjectedProfitPct
      : Math.floor(volatilityThresholdPct / 2);
  const watchState =
    (reserveLevels > 0 || maxNextAveragingLevels > 0) &&
    Number.isFinite(pctAlloc) &&
    pctAlloc > 0
      ? slowTradingClient.watchReserve.reserve.buildState({
          baseMarginUsdt: capacity.entryMarginUsdt,
          direction: "LONG",
          entryLevel: 0,
          maxNextLevels: maxNextAveragingLevels,
          pctAlloc,
          reserveLevels,
        })
      : undefined;
  const reserveStepsUsdt =
    watchState?.steps
      .filter((step) => step.status === "RESERVED")
      .map((step) => step.marginUsdt) ?? [];
  const averagingStepsUsdt =
    watchState?.steps
      .slice(0, maxNextAveragingLevels)
      .map((step) => step.marginUsdt) ?? [];
  const projectedBailoutStepIndex =
    watchState?.steps.findIndex(
      (step) =>
        step.status === "UNRESERVED" &&
        step.marginUsdt === capacity.projectedBailoutBufferUsdt,
    ) ?? -1;
  const projectedBailoutStep = watchState?.steps.find(
    (step) =>
      step.status === "UNRESERVED" &&
      step.marginUsdt === capacity.projectedBailoutBufferUsdt,
  );
  const exitStages = [
    capacity.entryMarginUsdt,
    ...averagingStepsUsdt,
  ].map<TradingLivePreviewExitStage>((_marginUsdt, index, marginParts) => {
    const cumulativeMarginUsdt =
      slowTradingClient.watchReserve.money.roundUsdt(
        marginParts
          .slice(0, index + 1)
          .reduce((sum, marginUsdt) => sum + marginUsdt, 0),
      );
    const estimatedNotionalUsdt =
      slowTradingClient.watchReserve.money.roundUsdt(
        cumulativeMarginUsdt * leverage,
      );
    const counterMarginUsdt =
      capacity.workerLegs === 2 ? capacity.entryMarginUsdt : 0;
    const counterNotionalUsdt =
      slowTradingClient.watchReserve.money.roundUsdt(
        counterMarginUsdt * leverage,
      );
    const counterExitMovePct =
      capacity.workerLegs === 2
        ? Number((index * volatilityThresholdPct).toFixed(8))
        : 0;
    const estimatedLossUsdt =
      stopLossPct === null
        ? null
        : slowTradingClient.watchReserve.money.roundUsdt(
            estimatedNotionalUsdt * (stopLossPct / 100),
          );
    const estimatedCounterProfitUsdt =
      counterMarginUsdt <= 0
        ? 0
        : slowTradingClient.watchReserve.money.roundUsdt(
            counterNotionalUsdt * (counterExitMovePct / 100),
          );
    const estimatedNetLossUsdt =
      estimatedLossUsdt === null
        ? null
        : slowTradingClient.watchReserve.money.roundUsdt(
            Math.max(0, estimatedLossUsdt - estimatedCounterProfitUsdt),
          );
    const postAverageThreshold = postAverageStopLoss.threshold.get(
      index,
      config.modelConfig.postAverageStopLoss,
    );
    const postAveragePercentLossUsdt =
      (postAverageThreshold?.maxNetPnlPct ?? 0) < 0
        ? slowTradingClient.watchReserve.money.roundUsdt(
            estimatedNotionalUsdt *
              (Math.abs(postAverageThreshold?.maxNetPnlPct ?? 0) / 100),
          )
        : null;
    const postAverageUsdtLossUsdt =
      (postAverageThreshold?.maxNetPnlUsdt ?? 0) < 0
        ? Math.abs(postAverageThreshold?.maxNetPnlUsdt ?? 0)
        : null;
    const postAverageFirstLossUsdt =
      postAveragePercentLossUsdt === null
        ? postAverageUsdtLossUsdt
        : postAverageUsdtLossUsdt === null
          ? postAveragePercentLossUsdt
          : Math.min(postAveragePercentLossUsdt, postAverageUsdtLossUsdt);
    const postAveragePairLossUsdt =
      postAverageFirstLossUsdt === null
        ? null
        : slowTradingClient.watchReserve.money.roundUsdt(
            Math.max(
              0,
              postAverageFirstLossUsdt - estimatedCounterProfitUsdt,
            ),
          );
    const firstStopLoss = resolveFirstStopLoss({
      estimatedHardStopLossUsdt: estimatedLossUsdt,
      estimatedPairHardStopLossUsdt: estimatedNetLossUsdt,
      hasCounterLeg: capacity.workerLegs === 2,
      netUsdtStopLossUsdt: stopLossUSDT,
      postAveragePairLossUsdt,
      postAverageStopLossUsdt: postAverageFirstLossUsdt,
    });

    return {
      averagingStepsUsed: index,
      counterExitMovePct,
      counterMarginUsdt,
      counterNotionalUsdt,
      cumulativeMarginUsdt,
      estimatedCounterProfitUsdt,
      firstStopLoss,
      estimatedLossUsdt,
      estimatedNetLossUsdt,
      estimatedNotionalUsdt,
      estimatedProfitUsdt:
        slowTradingClient.watchReserve.money.roundUsdt(
          estimatedNotionalUsdt * (takeProfitPct / 100),
        ),
      postAverageStopLoss: postAverageThreshold
        ? {
            estimatedPercentLossUsdt: postAveragePercentLossUsdt,
            maxNetPnlPct: postAverageThreshold.maxNetPnlPct,
            maxNetPnlUsdt: postAverageThreshold.maxNetPnlUsdt,
            usdtEquivalentPct:
              postAverageUsdtLossUsdt === null || estimatedNotionalUsdt <= 0
                ? null
                : Number(
                    ((postAverageUsdtLossUsdt / estimatedNotionalUsdt) * 100).toFixed(
                      2,
                    ),
                  ),
          }
        : null,
      stopLossUSDTEquivalentPct:
        stopLossUSDT === null || estimatedNotionalUsdt <= 0
          ? null
          : Number(((stopLossUSDT / estimatedNotionalUsdt) * 100).toFixed(2)),
      estimatedTargetZoneLossUsdt:
        targetZoneStopLossPct === null
          ? null
          : slowTradingClient.watchReserve.money.roundUsdt(
              estimatedNotionalUsdt * (targetZoneStopLossPct / 100),
            ),
      marginPartsUsdt: marginParts.slice(0, index + 1),
      stage: index + 1,
      volatilityThresholdPct,
    };
  });
  const averagingSimulation =
    config.enableWatchLogic === false
      ? null
      : buildTradingLivePreviewAveragingSimulation({
          entryMarginUsdt: capacity.entryMarginUsdt,
          leverage,
          requiredProfitPct: requiredProjectedProfitPct,
          reserveMultiplier: pctAlloc,
          targetMovePct: volatilityThresholdPct,
        });

  return {
    averagingSimulation,
    availableWorkers: capacity.availableWorkers,
    balanceAvailableWorkers: capacity.balanceAvailableWorkers,
    bailoutCandidates,
    bailoutBufferUsdt: capacity.bailoutBufferUsdt,
    entryBudgetUsdt: capacity.entryBudgetUsdt,
    entryMarginUsdt: capacity.entryMarginUsdt,
    exitStages,
    leverage,
    currentOpenPositions: capacity.currentOpenPositions,
    maxOpenPositions: capacity.maxOpenPositions,
    projectedBailoutLevel: projectedBailoutStep?.level ?? null,
    projectedBailoutMultiplier:
      projectedBailoutStep?.allocationPct ?? null,
    projectedBailoutPartsUsdt:
      projectedBailoutStepIndex >= 0
        ? [
            capacity.entryMarginUsdt,
            ...(watchState?.steps
              .slice(0, projectedBailoutStepIndex)
              .map((step) => step.marginUsdt) ?? []),
          ]
        : [],
    projectedBailoutUsdt: capacity.projectedBailoutBufferUsdt,
    reserveBudgetUsdt: slowTradingClient.watchReserve.money.roundUsdt(
      Math.max(
        0,
        capacity.workerCostUsdt -
          capacity.entryMarginUsdt * capacity.workerLegs,
      ),
    ),
    reserveStepsUsdt,
    remainingPositionSlots: capacity.remainingPositionSlots,
    spendableUsdt: capacity.spendableUsdt,
    stopLossPct,
    stopLossUSDT,
    takeProfitPct,
    targetZoneStopLossPct,
    workerCostUsdt: capacity.workerCostUsdt,
    workerLegs: capacity.workerLegs,
  };
}
