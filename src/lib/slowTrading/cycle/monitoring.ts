import brain from "@/lib/brain";
import type { EntryRecommendation } from "@/lib/brain";
import dynamic from "@/lib/dynamic";
import trading from "@/lib/trading";
import bothDirection from "@/lib/trading/both-direction";
import type { Position, PositionRole } from "@/lib/trading/models";
import streakBreak from "@/lib/trading/streak-break";
import slowTradingBalance from "../balance";
import slowTradingBlackSwan from "../black-swan";
import slowTradingNotifications from "../notifications";
import slowTradingPositions from "../positions";
import slowTradingShared from "../shared";
import slowTradingWatchReserve from "../watch-reserve";
import slowTradingCycleDailyPnl from "./daily-pnl";
import slowTradingCycleChecks from "./checks";
import type { SlowTradingCycleRuntime } from "./types";

/** Executes exits before averaging so a position cannot do both in one pass. */
async function execute(runtime: SlowTradingCycleRuntime): Promise<void> {
  const {
    activeMode,
    currentTimeMs,
    dynamicTradeMemory,
    exchangeType,
    forcedExitRolesBySymbol,
    forcedExitSymbols,
    isSandbox,
    modelConfig,
    modelMemoryMap,
    modeState,
    profiler,
    reports,
    shouldAutoEnter,
    shouldAutoExit,
    shouldMonitor,
    storage,
    symbols,
    tradeSettings,
    tradingMode,
    volatilityPointsMap,
  } = runtime;

  // G. Process exit logic for any currently open positions.
  // PROD:MONITORING_OPEN_POSITION
  const hasForcedPositionExit = Object.values(modelMemoryMap).some(
    (modelMemory) =>
      (modelMemory.positions ?? []).some(
        (position: Position) => position.control?.forceExit !== undefined,
      ),
  );
  const selectedExecutionSymbols = new Set(symbols);
  const symbolsToExit =
    shouldAutoExit || hasForcedPositionExit
      ? tradeSettings.filter((item) => {
          const symbol = String(item.symbol || "")
            .trim()
            .toUpperCase();
          if (!selectedExecutionSymbols.has(symbol)) {
            return false;
          }

          const modelMemory = modelMemoryMap[item.symbol ?? ""];
          const hasOpenPositions = (modelMemory?.positions ?? []).length > 0;
          if (!hasOpenPositions) {
            return false;
          }

          const hasForceSellPosition = (modelMemory?.positions ?? []).some(
            (position: Position) => position.control?.forceExit !== undefined,
          );
          if (storage.runtime.autoExitEnabled || hasForceSellPosition) {
            return true;
          }

          return forcedExitSymbols.has(symbol);
        })
      : [];

  for (const trade of symbolsToExit) {
    const modelMemory = modelMemoryMap[trade.symbol ?? ""];
    const positionRoles: PositionRole[] = (modelMemory.positions ?? [])
      .filter((position: Position) => !position.closed)
      .map((position: Position) =>
        position.role === "COUNTER" ? "COUNTER" : "MAIN",
      );
    const forcedRoles = forcedExitRolesBySymbol.get(
      String(trade.symbol || "")
        .trim()
        .toUpperCase(),
    );
    const roles: Array<PositionRole | undefined> = forcedRoles
      ? Array.from(forcedRoles).filter((role) => positionRoles.includes(role))
      : bothDirection.config.isEnabled(storage.config.openDirection)
        ? Array.from(new Set(positionRoles))
        : [undefined];

    for (const positionRole of roles) {
      const reservedBefore = slowTradingBalance.reserve.getOpen(modelMemory);
      const report = await profiler.time("cycle.exitExecution", () =>
        trading.execution.exit({
          symbol: trade.symbol ?? "",
          modelConfig,
          modelMemory,
          exchangeType,
          futuresPositionMode: storage.account.futuresPositionMode,
          tradingMode,
          bypass: false,
          notificationTarget: {
            dashboard: "SLOW",
            // PROD:NOTIF_EXIT
            successKey: "NOTIF_EXIT",
            // PROD:NOTIF_EXIT_FAILED
            failureKey: "NOTIF_EXIT_FAILED",
          },
          simulate: isSandbox,
          balanceOverride: isSandbox
            ? {
                quoteAsset: dynamicTradeMemory.quoteAsset,
                baseAsset: 0,
              }
            : undefined,
          positionRole,
        }),
      );

      reports.push(report);
      runtime.executionChecks.push(
        slowTradingCycleChecks.build.execution({
          report,
          role: positionRole,
          symbol: trade.symbol ?? "",
        }),
      );

      if (isSandbox && report.tradingDetail) {
        dynamicTradeMemory.quoteAsset = report.tradingDetail.finalBalance;
      }

      if (report.tradingDetail?.action === "SELL") {
        const reservedAfter = slowTradingBalance.reserve.getOpen(modelMemory);
        slowTradingBalance.reserve.subtract(
          dynamicTradeMemory,
          Math.max(0, reservedBefore - reservedAfter),
        );
        slowTradingBalance.reserve.releaseClosedPosition(modelMemory);
      }
    }
  }

  if (reports.some((report) => report.tradingDetail?.action === "SELL")) {
    runtime.dailyPnlLimitEvaluation = await profiler.time(
      "cycle.dailyPnlLimit",
      () =>
        slowTradingCycleDailyPnl.evaluateCurrent({
          currentTimeMs,
          includePendingArchive: true,
          mode: activeMode,
          modeState: { ...modeState, tradeSettings },
          thresholdUsdt: runtime.dailyPnlLimitThresholdUsdt,
        }),
    );
    modeState.dailyPnlLimitState = {
      d: runtime.dailyPnlLimitEvaluation.day,
      usdt: runtime.dailyPnlLimitEvaluation.pnlUsdt,
    };
    await slowTradingNotifications.dailyPnlLimit.notify({
      currentTimeMs,
      evaluation: runtime.dailyPnlLimitEvaluation,
      exchangeType,
      mode: activeMode,
      modeState,
      notification: storage.runtime.notification,
    });
  }

  // G.1 Average only positions that remain open after exit evaluation.
  if (
    shouldMonitor &&
    storage.config.enableWatchLogic &&
    !runtime.blackSwanProtectionActive &&
    !slowTradingBlackSwan.runtime.isProtectionPending(activeMode)
  ) {
    // BOTH:WATCH_MECHANISM
    const selectedSymbols = new Set(symbols);
    const allActivePositions = slowTradingPositions.active
      .withTradeSymbols(tradeSettings)
      .filter((position) =>
        selectedSymbols.has(
          slowTradingPositions.symbol.normalize(position.symbol),
        ),
      );

    const watchResult =
      slowTradingWatchReserve.averaging.generateRecommendations({
        activePositions: allActivePositions,
        pairPositions: tradeSettings.flatMap((item) => [
          ...(item.model_memory.positions ?? []),
          ...(item.model_memory.positionsSell ?? []),
        ]),
        volatilityPointsMap,
        config: storage.config,
        quoteAsset: dynamicTradeMemory.quoteAsset,
        reservedQuoteAsset: dynamicTradeMemory.reservedQuoteAsset,
      });

    const recommendationBySymbol = new Map(
      watchResult.recommendations
        .filter((rec) => rec.symbol)
        .map((rec) => [rec.symbol!.toUpperCase(), rec]),
    );
    const recommendedSymbols = new Set(
      watchResult.recommendations
        .map((rec) => rec.symbol?.toUpperCase())
        .filter(Boolean),
    );
    const symbolsToAverage = tradeSettings.filter((item) => {
      const symbol = item.symbol?.toUpperCase();
      return (
        symbol &&
        selectedSymbols.has(symbol) &&
        recommendedSymbols.has(symbol) &&
        (modelMemoryMap[symbol]?.positions?.length ?? 0) > 0
      );
    });

    for (const trade of symbolsToAverage) {
      if (slowTradingBlackSwan.runtime.isProtectionPending(activeMode)) {
        break;
      }
      const modelMemory = modelMemoryMap[trade.symbol ?? ""];
      const recommendation = recommendationBySymbol.get(
        (trade.symbol ?? "").toUpperCase(),
      );
      const reservedBefore = slowTradingBalance.reserve.getOpen(modelMemory);
      const report = await profiler.time("cycle.averagingExecution", () =>
        trading.execution.averaging({
          symbol: trade.symbol ?? "",
          modelConfig,
          modelMemory,
          volatilityPoints: volatilityPointsMap[trade.symbol ?? ""] ?? [],
          exchangeType,
          futuresPositionMode: storage.account.futuresPositionMode,
          tradingMode,
          bypass: false,
          balanceOverride: {
            quoteAsset: dynamicTradeMemory.quoteAsset,
            baseAsset: 0,
          },
          reservedQuoteAsset: dynamicTradeMemory.reservedQuoteAsset,
          averagingRecommendation: recommendation,
          adaptiveAveraging: storage.config.adaptiveAveraging,
          averagingRescueProjectionGuardEnabled:
            storage.config.averagingRescueProjectionGuardEnabled !== false,
        }),
      );

      reports.push(report);
      runtime.executionChecks.push(
        slowTradingCycleChecks.build.execution({
          report,
          symbol: trade.symbol ?? "",
        }),
      );

      if (report.tradingDetail?.action === "BUY") {
        const reservedAfter = slowTradingBalance.reserve.getOpen(modelMemory);
        slowTradingBalance.reserve.subtract(
          dynamicTradeMemory,
          Math.max(0, reservedBefore - reservedAfter),
        );

        dynamicTradeMemory.quoteAsset = slowTradingWatchReserve.money.roundUsdt(
          (dynamicTradeMemory.quoteAsset ?? 0) + report.tradingDetail.usdtSpent,
        );
      }
    }
  }

  // G.2 Replenish a missing streak-break role after exits and averaging.
  if (
    shouldAutoEnter &&
    !runtime.dailyPnlLimitEvaluation.reached &&
    bothDirection.config.isEnabled(storage.config.openDirection) &&
    !runtime.blackSwanProtectionActive &&
    !slowTradingBlackSwan.runtime.isProtectionPending(activeMode)
  ) {
    const selectedSymbols = new Set(symbols);
    const reentries = tradeSettings.flatMap((tradeSetting) => {
      const symbol = String(tradeSetting.symbol || "")
        .trim()
        .toUpperCase();
      if (!selectedSymbols.has(symbol)) return [];

      const modelMemory = modelMemoryMap[symbol];
      const decision = streakBreak.reentry.resolve({
        positions: modelMemory?.positions ?? [],
        pendingReentries: modelMemory?.pendingReentries,
        volatilityPoints: volatilityPointsMap[symbol] ?? [],
      });
      if (!decision) return [];

      if (decision.status !== "READY" || !decision.point) {
        slowTradingShared.entrySignals.addSkipped(runtime.skippedEntrySignals, {
          role: decision.role,
          symbol,
          reason: decision.reason,
        });
        return [];
      }

      return [{ decision, modelMemory, point: decision.point, symbol }];
    });

    if (reentries.length > 0) {
      const currentBalance = dynamic.balance.countGrowthOvertime({
        timeMs: currentTimeMs,
        dynamicTradeMemory,
        modelMemoryMap,
        volatilityMap: volatilityPointsMap,
      });
      let investAmount = brain.algorithms.runtime.getInvestmentAmount({
        dynamicTradeMemory,
        currentBalance,
        allocationPercent: 1,
        recommendedPositionsLength: reentries.length,
      });
      if (runtime.bypass) {
        investAmount = Math.min(investAmount, 10);
      }
      const volume24hBySymbol =
        (storage.config.maxEntryBased24HourVolPct ?? 0.2) > 0
          ? await runtime.sharedMarket.volume24h.get()
          : {};

      for (const { decision, modelMemory, point, symbol } of reentries) {
        if (investAmount < trading.constants.MINIMAL_USDT_TO_TRADE) {
          slowTradingShared.entrySignals.addSkipped(
            runtime.skippedEntrySignals,
            {
              role: decision.role,
              symbol,
              reason:
                `Re-entry budget ${investAmount.toFixed(2)} USDT is below minimum ` +
                `${trading.constants.MINIMAL_USDT_TO_TRADE.toFixed(2)} USDT`,
            },
          );
          continue;
        }

        decision.survivor.pairId = decision.pairId;
        const entrySignal: EntryRecommendation = {
          ...point,
          amountProbab: point.probability ?? 1,
          maxLeverage: decision.survivor.exposure.leverage,
          message: decision.reason,
          symbol,
        };
        const reservedBefore = slowTradingBalance.reserve.getOpen(modelMemory);
        const report = await profiler.time("cycle.entryExecution", () =>
          trading.execution.pairLegEntry({
            investAmount,
            entrySignal,
            modelConfig,
            modelMemory,
            exchangeType,
            tradingMode,
            bypass: false,
            notificationTarget: {
              dashboard: "SLOW",
              successKey: "NOTIF_ENTRY",
              failureKey: "NOTIF_ENTRY_FAILED",
            },
            simulate: isSandbox,
            balanceOverride: isSandbox
              ? {
                  quoteAsset: dynamicTradeMemory.quoteAsset,
                  baseAsset: 0,
                }
              : undefined,
            executionMode: activeMode,
            reservedQuoteAsset: dynamicTradeMemory.reservedQuoteAsset,
            dynamicTradeConfig: storage.config,
            allModelMemories: Object.values(modelMemoryMap),
            volume24h: volume24hBySymbol[symbol],
            futuresPositionMode: storage.account.futuresPositionMode,
            direction: decision.direction,
            entryLegs: decision.survivor.entryLegs,
            pairId: decision.pairId,
            role: decision.role,
          }),
        );
        reports.push(report);
        runtime.executionChecks.push(
          slowTradingCycleChecks.build.execution({
            report,
            role: decision.role,
            symbol,
          }),
        );

        if (report.tradingDetail?.action === "BUY") {
          slowTradingWatchReserve.volatilityPoint.markUsed({
            entrySignal,
            modelMemory,
            roles: [decision.role],
          });
          dynamicTradeMemory.quoteAsset = slowTradingWatchReserve.money.roundUsdt(
            (dynamicTradeMemory.quoteAsset ?? 0) +
              report.tradingDetail.usdtSpent,
          );
          const reservedAfter = slowTradingBalance.reserve.getOpen(modelMemory);
          slowTradingBalance.reserve.add(
            dynamicTradeMemory,
            Math.max(0, reservedAfter - reservedBefore),
          );
        } else {
          slowTradingShared.entrySignals.addSkipped(
            runtime.skippedEntrySignals,
            {
              role: decision.role,
              symbol,
              reason: report.message,
            },
          );
        }
      }
    }
  }
}

const slowTradingCycleMonitoring = {
  execute,
} as const;

export default slowTradingCycleMonitoring;
