import {
  assignModelMemory,
  assignVolatility,
} from "@/components/api/production/utils";
import brain, { type EntryRecommendation } from "@/lib/brain";
import dynamic, { type VolatilityPoint } from "@/lib/dynamic";
import { VOLATILITY_THRESHOLD } from "@/lib/brain/constants";
import { getExchange, TradingMode } from "@/lib/exchange";
import exchangeFundingRate from "@/lib/exchange/funding-rate";
import { resolveMarketTypeForTradingMode } from "@/lib/exchange/utils";
import trading, { type TradingReturn } from "@/lib/trading";
import blackSwan from "@/lib/trading/black-swan";
import bothDirection from "@/lib/trading/both-direction";
import type { Position, PositionRole } from "@/lib/trading/models";
import streakBreak from "@/lib/trading/streak-break";
import slowTradingReporting from "./reporting";
import slowTradingStorage from "./storage";
import slowTradingWatchReserve from "./watch-reserve";
import type {
  SlowTradingMode,
  SlowTradingModeState,
  SlowTradingStageRunCheck,
} from "./types";
import slowTradingBalance from "./balance";
import slowTradingCache from "./cache";
import slowTradingExchangeSync from "./exchange-sync";
import slowTradingMarket from "./market";
import slowTradingNotifications from "./notifications";
import slowTradingPerformance, {
  type SlowTradingCyclePerformanceEntry,
  type SlowTradingCyclePerformanceObserver,
} from "./performance";
import slowTradingMarketVolume from "./market-volume";
import slowTradingPositions from "./positions";
import slowTradingSignals from "./signals";
import slowTradingShared, {
  type SlowTradingSkippedEntrySignal,
} from "./shared";
import slowTradingSidewaysExit from "./exit-sideways";
import slowTradingAutoRemoveSymbols from "./auto-remove-symbols";
import { tradeLog } from "@/lib/trading/helper/log";
import slowTradingStages, { type SlowTradingStage } from "./stages";
import slowTradingMutationQueue from "./mutation-queue";
import slowTradingStageRun from "./stage-run";
import slowTradingBlackSwan from "./black-swan";
import slowTradingDailyPnlLimit, {
  type DailyPnlLimitEvaluation,
} from "./daily-pnl-limit";

const MAX_STAGE_RUN_CHECKS = 100;
const MAX_STAGE_RUN_CHECK_MESSAGE_LENGTH = 500;

/** Reads only today's archived trades and evaluates the navbar-style daily PnL stop. */
async function evaluateCurrentDailyPnlLimit(params: {
  currentTimeMs: number;
  includePendingArchive?: boolean;
  mode: SlowTradingMode;
  modeState: SlowTradingModeState;
  thresholdUsdt: number;
}): Promise<DailyPnlLimitEvaluation> {
  const period = slowTradingDailyPnlLimit.period.getCurrentUtc(
    params.currentTimeMs,
  );
  let pnlUsdt =
    params.modeState.dailyPnlLimitState?.d === period.day
      ? params.modeState.dailyPnlLimitState.usdt
      : null;
  if (pnlUsdt === null) {
    const archived = await slowTradingStorage.history.readRange({
      endTime: period.endTime,
      mode: params.mode,
      startTime: period.startTime,
    });
    pnlUsdt = slowTradingDailyPnlLimit.pnl.sumForUtcDay(
      archived,
      period.day,
    );
  }

  if (params.includePendingArchive) {
    const pendingArchive = params.modeState.tradeSettings.flatMap(
      (tradeSetting) => tradeSetting.model_memory.positionsSell ?? [],
    );
    pnlUsdt += slowTradingDailyPnlLimit.pnl.sumForUtcDay(
      pendingArchive,
      period.day,
    );
  }

  return slowTradingDailyPnlLimit.guard.evaluatePnl({
    currentTimeMs: params.currentTimeMs,
    pnlUsdt,
    thresholdUsdt: params.thresholdUsdt,
  });
}

/** Builds one compact navbar-debug result from an execution report. */
function buildStageRunExecutionCheck(params: {
  report: TradingReturn;
  role?: PositionRole;
  symbol: string;
}): SlowTradingStageRunCheck {
  const action =
    params.report.tradingDetail?.action ?? params.report.action ?? "HOLD";
  return {
    s: params.symbol.trim().toUpperCase(),
    r: params.role,
    a: action,
    ok: action === "BUY" || action === "SELL" || action === "SHORT",
    m: String(params.report.message || "No execution message")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_STAGE_RUN_CHECK_MESSAGE_LENGTH),
  };
}

/** Merges execution reports and skipped-entry reasons for the stage report. */
function buildStageRunChecks(params: {
  executionChecks: SlowTradingStageRunCheck[];
  skippedEntries: SlowTradingSkippedEntrySignal[];
}): SlowTradingStageRunCheck[] {
  const checks = [...params.executionChecks];
  for (const skipped of params.skippedEntries) {
    const check: SlowTradingStageRunCheck = {
      s: skipped.symbol.trim().toUpperCase(),
      r: skipped.role,
      a: "BLOCKED",
      ok: false,
      m: skipped.reason
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_STAGE_RUN_CHECK_MESSAGE_LENGTH),
    };
    if (
      !checks.some(
        (candidate) =>
          candidate.s === check.s &&
          candidate.r === check.r &&
          candidate.m === check.m,
      )
    ) {
      checks.push(check);
    }
  }
  return checks.slice(-MAX_STAGE_RUN_CHECKS);
}

interface RunSlowTradingCycleParams {
  bypass?: boolean;
  ignoreRunnerEnabled?: boolean;
  forceExitSymbols?: string[];
  forceExitTargets?: Array<{ role: PositionRole; symbol: string }>;
  forceEntrySymbols?: string[];
  disableAutoEntry?: boolean;
  stage?: SlowTradingStage;
  performance?: SlowTradingCyclePerformanceObserver;
}

/** Execute one serialized SLOW cycle and persist its active-mode result. */
async function executeSlowTradingCycle(params?: RunSlowTradingCycleParams) {
  // A. Load the current active mode and runtime controls.
  const cycleStartedAt = Date.now();
  const performanceEntries: SlowTradingCyclePerformanceEntry[] = [];
  const profiler = slowTradingPerformance.cycle.createProfiler({
    now: params?.performance?.now,
    onSection: (entry) => {
      performanceEntries.push(entry);
      params?.performance?.onSection?.(entry);
    },
  });
  // PROD:CYCLE_PERFORMANCE_SECTION_DURATION
  const storage = await profiler.time("storage.load", () =>
    slowTradingStorage.data.load({
      modeScope: "active",
    }),
  );
  return slowTradingStorage.account.runWithExchangeAccount(storage, async () =>
    profiler.time("cycle.total", async () => {
      const activeMode = slowTradingStorage.mode.getActive(storage);
      const modeState = slowTradingStorage.mode.ensureTradeSettings(
        storage.modes[activeMode],
        storage.config.symbols,
      );
      storage.modes[activeMode] = modeState;
      const blackSwanProtectionActive =
        blackSwan.state.isProtective(modeState.blackSwan) ||
        slowTradingBlackSwan.runtime.isProtectionPending(activeMode);
      const stage = params?.stage;
      const speedupCriteria = {
        negativePnlThresholdPct:
          storage.runtime.speedupStageNegativePnlThresholdPct,
        positivePnlThresholdPct:
          storage.runtime.speedupStagePositivePnlThresholdPct,
        takeProfitOffsetPct: storage.runtime.speedupStageTakeProfitOffsetPct,
        takeProfitPercent: storage.config.modelConfig.takeProfitPercent,
        useStopLossPlus: storage.config.modelConfig.useStopLossPlus,
        volatilityThresholdPct: VOLATILITY_THRESHOLD,
      };
      const stageSymbols = stage
        ? slowTradingStages.symbols.select({
            configuredSymbols: storage.config.symbols,
            modeState,
            speedupNegativePnlThresholdPct:
              speedupCriteria.negativePnlThresholdPct,
            speedupPositivePnlThresholdPct:
              speedupCriteria.positivePnlThresholdPct,
            speedupTakeProfitOffsetPct: speedupCriteria.takeProfitOffsetPct,
            stage,
            takeProfitPercent: speedupCriteria.takeProfitPercent,
            useStopLossPlus: speedupCriteria.useStopLossPlus,
            volatilityThresholdPct: speedupCriteria.volatilityThresholdPct,
          })
        : null;
      const monitoringStage =
        stage === "speedup"
          ? "speedup"
          : stage === "standard-monitoring"
            ? "standard"
            : undefined;
      const monitoringReasonByPosition: Record<string, string> = {};
      if (monitoringStage && stageSymbols) {
        const selectedSymbols = new Set(stageSymbols);
        for (const tradeSetting of modeState.tradeSettings) {
          const symbol = String(tradeSetting.symbol || "")
            .trim()
            .toUpperCase();
          if (!selectedSymbols.has(symbol)) {
            continue;
          }

          const volatilityPoints =
            tradeSetting.model_memory.volatility?.lastVolatility ?? [];
          for (const position of (tradeSetting.model_memory.positions ??
            []) as Position[]) {
            if (position.closed) {
              continue;
            }
            const reasons = slowTradingStages.position.getSpeedupReasons({
              ...speedupCriteria,
              latestVolatilityPoint: volatilityPoints.at(-1),
              pairPositions: [
                ...(tradeSetting.model_memory.positions ?? []),
                ...(tradeSetting.model_memory.positionsSell ?? []),
              ],
              position,
              volatilityPoints,
            });
            monitoringReasonByPosition[
              slowTradingReporting.positions.monitoringKey(symbol, position)
            ] =
              reasons.length > 0
                ? slowTradingStages.position.describeSpeedupReasons(reasons)
                : monitoringStage === "standard"
                  ? slowTradingStages.position.describeStandardReason({
                      negativePnlThresholdPct:
                        speedupCriteria.negativePnlThresholdPct,
                      positivePnlThresholdPct:
                        speedupCriteria.positivePnlThresholdPct,
                      position,
                    })
                  : "Symbol selected for Speedup monitoring";
          }
        }
      }
      const shouldCaptureEntry = !stage || stage === "capture-entry";
      const shouldMonitor =
        !stage || stage === "speedup" || stage === "standard-monitoring";
      const forcedAllExitSymbols = new Set(
        (params?.forceExitSymbols ?? [])
          .map((symbol) =>
            String(symbol || "")
              .trim()
              .toUpperCase(),
          )
          .filter(Boolean),
      );
      const forcedExitRolesBySymbol = new Map<string, Set<PositionRole>>();
      for (const target of params?.forceExitTargets ?? []) {
        const symbol = String(target.symbol || "")
          .trim()
          .toUpperCase();
        if (!symbol) {
          continue;
        }
        const roles = forcedExitRolesBySymbol.get(symbol) ?? new Set();
        roles.add(target.role);
        forcedExitRolesBySymbol.set(symbol, roles);
      }
      const forcedExitSymbols = new Set([
        ...forcedAllExitSymbols,
        ...forcedExitRolesBySymbol.keys(),
      ]);
      const forcedEntrySymbols = new Set(
        (params?.forceEntrySymbols ?? [])
          .map((symbol) =>
            String(symbol || "")
              .trim()
              .toUpperCase(),
          )
          .filter(Boolean),
      );
      if (!storage.runtime.runnerEnabled && !params?.ignoreRunnerEnabled) {
        const availableQuoteAsset =
          (modeState.dynamicTradeMemory.quoteAsset ?? 0) +
          (modeState.dynamicTradeMemory.safeHaven ?? 0);
        return {
          mode: activeMode as SlowTradingMode,
          stage,
          symbols: stageSymbols ?? [],
          reports: [],
          executedEntrySignals: 0,
          skippedEntrySignals: [],
          availableQuoteAsset,
          lastRunAt: modeState.lastRunAt,
          skipped: true,
        };
      }
      let dailyPnlLimitThresholdUsdt =
        storage.runtime.autoEntryDailyPnlLimitUSDT;
      let dailyPnlLimitEvaluation = slowTradingDailyPnlLimit.guard.evaluate({
        currentTimeMs: cycleStartedAt,
        positions: [],
        thresholdUsdt: dailyPnlLimitThresholdUsdt,
      });
      if (shouldCaptureEntry && forcedEntrySymbols.size === 0) {
        dailyPnlLimitEvaluation = await profiler.time(
          "cycle.dailyPnlLimit",
          () =>
            evaluateCurrentDailyPnlLimit({
              currentTimeMs: cycleStartedAt,
              mode: activeMode,
              modeState,
              thresholdUsdt: dailyPnlLimitThresholdUsdt,
            }),
        );
        modeState.dailyPnlLimitState = {
          d: dailyPnlLimitEvaluation.day,
          usdt: dailyPnlLimitEvaluation.pnlUsdt,
        };
        await slowTradingNotifications.dailyPnlLimit.notify({
          currentTimeMs: cycleStartedAt,
          evaluation: dailyPnlLimitEvaluation,
          exchangeType: storage.config.exchangeType,
          mode: activeMode,
          modeState,
          notification: storage.runtime.notification,
        });
      }
      const shouldAutoEnter =
        !blackSwanProtectionActive &&
        (stage === "capture-entry" && stageSymbols?.length === 0
          ? false
          : shouldCaptureEntry && forcedEntrySymbols.size > 0
            ? true
            : !shouldCaptureEntry || params?.disableAutoEntry === true
              ? false
              : storage.runtime.autoEntryEnabled &&
                !dailyPnlLimitEvaluation.reached);
      const shouldAutoExit =
        shouldMonitor &&
        (storage.runtime.autoExitEnabled || forcedExitSymbols.size > 0);
      const bypass = params?.bypass ?? storage.runtime.entrySignalBypass;

      if (stage && stageSymbols?.length === 0) {
        const availableQuoteAsset =
          (modeState.dynamicTradeMemory.quoteAsset ?? 0) +
          (modeState.dynamicTradeMemory.safeHaven ?? 0);
        const summary =
          `${activeMode} ${stage} cycle finished with 0 eligible symbol(s)` +
          ` | auto entry ${shouldAutoEnter ? "on" : "off"}` +
          ` | auto exit ${shouldAutoExit ? "on" : "off"}`;

        const runStats = slowTradingStageRun.recordCompleted({
          cycleStartedAt,
          modeState,
          performanceEntries,
          reports: 0,
          stage,
          summary,
          symbols: 0,
        });
        storage.modes[activeMode] = modeState;
        // Empty heartbeats use one memory write and intentionally do not time
        // that write, avoiding recursive persistence just to record its duration.
        await slowTradingStorage.mode.saveState(activeMode, modeState);

        return {
          mode: activeMode as SlowTradingMode,
          stage,
          symbols: [],
          reports: [],
          executedEntrySignals: 0,
          skippedEntrySignals: [],
          availableQuoteAsset,
          lastRunAt: runStats.t,
          lastRunDurationMs: runStats.ms,
        };
      }

      // A.1 Prepare the mode balance context before signal generation.
      const isSandbox = activeMode === "sandbox";
      if (isSandbox) {
        slowTradingBalance.sandbox.ensureBalance(
          modeState,
          storage.runtime.sandboxInitialBalanceUSDT,
        );
      }

      const signalBuildResult = shouldAutoEnter
        ? await profiler.time("signals.build", () =>
            slowTradingSignals.build({
              storage,
              bypass,
              forceEntrySymbols: Array.from(forcedEntrySymbols),
              symbols: stageSymbols ?? undefined,
              performance: profiler,
            }),
          )
        : null;
      const rawEntrySignals =
        signalBuildResult?.entrySignals ?? ([] as EntryRecommendation[]);

      // B. Restore runtime memory and market context for execution.
      const tradeSettings =
        signalBuildResult?.tradeSettings ??
        slowTradingShared.clone(modeState.tradeSettings);
      if (forcedExitSymbols.size > 0) {
        for (const tradeSetting of tradeSettings) {
          const symbol = String(tradeSetting.symbol || "")
            .trim()
            .toUpperCase();
          if (
            forcedAllExitSymbols.has(symbol) &&
            (tradeSetting.model_memory.positions?.length ?? 0) > 0
          ) {
            tradeSetting.model_memory.forceSell = true;
          }

          const forcedRoles = forcedExitRolesBySymbol.get(symbol);
          if (!forcedRoles) {
            continue;
          }
          for (const position of (tradeSetting.model_memory.positions ??
            []) as Position[]) {
            const role =
              position.role === "COUNTER" ? "COUNTER" : "MAIN";
            if (position.closed || !forcedRoles.has(role)) {
              continue;
            }
            // PROD:MANUAL_EXIT_POSITION_ROLE
            position.control ??= {};
            position.control.forceExit = {
              closeReason: "FINAL",
              reason: "Position was manually exited",
            };
          }
        }
      }

      if (shouldAutoEnter && forcedEntrySymbols.size > 0) {
        for (const tradeSetting of tradeSettings) {
          const symbol = String(tradeSetting.symbol || "")
            .trim()
            .toUpperCase();
          if (
            forcedEntrySymbols.has(symbol) &&
            (tradeSetting.model_memory.positions?.length ?? 0) === 0
          ) {
            tradeSetting.model_memory.justBuy = true;
          }
        }
      }

      const symbols = Array.from(
        new Set([
          ...(signalBuildResult?.symbols ??
            stageSymbols ??
            slowTradingShared.symbols.buildExecution(storage.config.symbols)),
          ...forcedExitSymbols,
        ]),
      );
      const modelMemoryMap: Record<string, any> =
        signalBuildResult?.modelMemoryMap ?? {};
      if (!signalBuildResult) {
        const modelMemoryRes = await profiler.time(
          "cycle.assignModelMemory",
          () => assignModelMemory(modelMemoryMap, tradeSettings),
        );
        if (typeof modelMemoryRes.error === "string") {
          throw new Error(modelMemoryRes.error);
        }

        await profiler.time("cycle.assignVolatility", () =>
          assignVolatility(
            modelMemoryMap,
            symbols,
            storage.config.exchangeType,
            storage.config.tradingMode,
            storage.config.minAbsLevelToEntry,
          ),
        );
      }

      const dynamicTradeMemory = {
        ...slowTradingShared.clone(dynamic.defaults.tradingMemory),
        ...slowTradingShared.clone(modeState.dynamicTradeMemory),
      };

      const exchangeType = storage.config.exchangeType;
      const tradingMode = storage.config.tradingMode;
      const marketType = resolveMarketTypeForTradingMode(tradingMode);

      const exchange = getExchange(exchangeType, {
        defaultTradingMode: tradingMode,
      });

      let currentTimeMs = Date.now();
      const firstSymbol = symbols[0];
      const firstKlines = firstSymbol
        ? await profiler.time("cycle.currentTimeKlines", () =>
            exchange.getKlines({
              symbol: `${firstSymbol}_USDT`,
              interval: "5m",
              marketType,
              simpleTime: "10minute",
            }),
          )
        : [];
      const firstKline = firstKlines.at(-1);
      if (firstKline) {
        currentTimeMs = firstKline[0];
      }

      // B.1 Refresh the quote balance according to live or sandbox execution mode.
      if (isSandbox) {
        if (!dynamicTradeMemory.startingBalanceUSDT) {
          dynamicTradeMemory.startingBalanceUSDT =
            storage.runtime.sandboxInitialBalanceUSDT;
        }
        if (!dynamicTradeMemory.quoteAsset) {
          dynamicTradeMemory.quoteAsset =
            storage.runtime.sandboxInitialBalanceUSDT;
        }
      } else {
        const realQuote = await profiler.time("cycle.balanceRefresh", () =>
          exchange.getBalance("USDT_USDT"),
        );
        if (realQuote == null) {
          throw new Error("Can't fetch real balance!");
        }

        const available = realQuote.quoteAsset - dynamicTradeMemory.safeHaven;
        dynamicTradeMemory.quoteAsset = available;
        if (!dynamicTradeMemory.startingBalanceUSDT) {
          dynamicTradeMemory.startingBalanceUSDT = available;
        }
      }

      if (!isSandbox && tradingMode !== TradingMode.SPOT) {
        const selectedSymbols = new Set(symbols);
        const activePositionSymbols = slowTradingPositions.active
          .withTradeSymbols(tradeSettings)
          .map((position) =>
            slowTradingPositions.symbol.normalize(position.symbol),
          )
          .filter((symbol) => selectedSymbols.has(symbol))
          .filter(Boolean);

        if (activePositionSymbols.length > 0) {
          try {
            const [exchangePositions, latestPriceBySymbol] =
              await profiler.time("cycle.exchangePositionSync", () =>
                Promise.all([
                  exchange.getPositions(),
                  slowTradingMarket.price.buildLatestBySymbol({
                    exchange,
                    marketType,
                    symbols: activePositionSymbols,
                  }),
                ]),
              );
            const syncResult = slowTradingExchangeSync.positions.syncLiveOpen({
              currentTimeMs,
              exchangePositions,
              latestPriceBySymbol,
              modeState: { ...modeState, tradeSettings },
            });
            slowTradingBalance.reserve.subtract(
              dynamicTradeMemory,
              syncResult.releasedReserveUSDT,
            );

            if (syncResult.adjustedCount > 0 || syncResult.closedCount > 0) {
              tradeLog.log(
                "[slow-trading] synced live exchange positions",
                syncResult,
              );
            }
          } catch (error) {
            void slowTradingNotifications.operationalError
              .notify({
                source: "slow-trading:sync-exchange-positions",
                error,
                details: {
                  tradingMode,
                  exchangeType,
                },
              })
              .catch((notificationError) => {
                tradeLog.error(
                  "[slow-trading] failed to notify exchange sync error",
                  notificationError,
                );
              });
          }
        }
      }

      const modelConfig = slowTradingMarket.modelConfig.pick(storage);
      const executionModeState = { ...modeState, tradeSettings };

      // C. Filter entry signals according to trading mode and open-position safety.
      let entrySignals = rawEntrySignals;
      if (tradingMode === TradingMode.SPOT && forcedEntrySymbols.size === 0) {
        entrySignals = entrySignals.filter((item) => item.l === "B");
      }

      entrySignals = slowTradingSignals.filter.withoutOpenPositions(
        executionModeState,
        entrySignals,
      );
      entrySignals = slowTradingSignals.filter.actionableVolatilityLevel(
        entrySignals,
        storage.config.minAbsLevelToEntry,
        storage.config.maxAbsLevelToEntry,
      );
      entrySignals = slowTradingSignals.filter.unusedVolatilityPointId(
        executionModeState,
        entrySignals,
        modelMemoryMap,
        bothDirection.config.isEnabled(storage.config.openDirection)
          ? ["MAIN", "COUNTER"]
          : undefined,
      );

      const volatilityPointsMap: Record<string, VolatilityPoint[]> = {};
      for (const symbol of Object.keys(modelMemoryMap)) {
        volatilityPointsMap[symbol] =
          modelMemoryMap[symbol].volatility?.lastVolatility ?? [];
      }

      if (shouldCaptureEntry) {
        await slowTradingSidewaysExit.production.apply({
          config: storage.config,
          currentTimeMs,
          dynamicTradeMemory,
          entrySignals,
          exchange,
          exchangeType,
          marketType,
          modelMemoryMap,
          profiler,
        });
      }

      // D. Recompute the price-norm state used for dynamic sizing decisions.
      if (shouldCaptureEntry) {
        await profiler.time("cycle.priceNorm", () =>
          dynamic.priceNorm.generateInitial({
            currentTimeMs,
            symbols,
            startTime: currentTimeMs,
            dynamicTradeMemory,
            useCache: true,
            exchangeType,
            volatilityMap: volatilityPointsMap,
          }),
        );
      }

      void slowTradingNotifications.highVolatility
        .notify({
          modeState,
          volatilityPointsMap,
          exchangeType,
          notification: storage.runtime.notification,
        })
        .catch((notificationError) => {
          tradeLog.error(
            "[slow-trading] failed to notify high volatility",
            notificationError,
          );
        });

      const reports: TradingReturn[] = [];
      const executionChecks: SlowTradingStageRunCheck[] = [];
      const skippedEntrySignals: SlowTradingSkippedEntrySignal[] = [];
      let entryGuardMinimumPrice =
        storage.runtime.autoRemoveSymbolMinPrice ?? 0;
      if (shouldAutoEnter && entrySignals.length > 0) {
        const latestEntryGuardStorage = await profiler.time(
          "storage.load",
          () => slowTradingStorage.data.load({ modeScope: "active" }),
        );
        const latestProtectionActive =
          blackSwan.state.isProtective(
            latestEntryGuardStorage.modes[activeMode]?.blackSwan,
          ) || slowTradingBlackSwan.runtime.isProtectionPending(activeMode);
        if (latestProtectionActive) {
          for (const entrySignal of entrySignals) {
            slowTradingShared.entrySignals.addSkipped(skippedEntrySignals, {
              symbol: String(entrySignal.symbol || "")
                .trim()
                .toUpperCase(),
              reason:
                "Entry blocked because Black Swan protection activated " +
                "after this cycle prepared its signals.",
            });
          }
          entrySignals = [];
          for (const tradeSetting of tradeSettings) {
            tradeSetting.model_memory.justBuy = false;
          }
        }
        const latestConfiguredSymbols = new Set(
          latestEntryGuardStorage.config.symbols.map((symbol) =>
            String(symbol || "")
              .trim()
              .toUpperCase(),
          ),
        );
        entryGuardMinimumPrice =
          latestEntryGuardStorage.runtime.autoRemoveSymbolMinPrice ?? 0;
        if (forcedEntrySymbols.size === 0) {
          dailyPnlLimitThresholdUsdt =
            latestEntryGuardStorage.runtime.autoEntryDailyPnlLimitUSDT;
          dailyPnlLimitEvaluation = await profiler.time(
            "cycle.dailyPnlLimit",
            () =>
              evaluateCurrentDailyPnlLimit({
                currentTimeMs: Date.now(),
                mode: activeMode,
                modeState,
                thresholdUsdt: dailyPnlLimitThresholdUsdt,
              }),
          );
          modeState.dailyPnlLimitState = {
            d: dailyPnlLimitEvaluation.day,
            usdt: dailyPnlLimitEvaluation.pnlUsdt,
          };
          if (dailyPnlLimitEvaluation.reached) {
            for (const entrySignal of entrySignals) {
              slowTradingShared.entrySignals.addSkipped(
                skippedEntrySignals,
                {
                  symbol: String(entrySignal.symbol || "")
                    .trim()
                    .toUpperCase(),
                  reason:
                    slowTradingDailyPnlLimit.guard.describe(
                      dailyPnlLimitEvaluation,
                    ),
                },
              );
            }
            entrySignals = [];
          }
          await slowTradingNotifications.dailyPnlLimit.notify({
            currentTimeMs: Date.now(),
            evaluation: dailyPnlLimitEvaluation,
            exchangeType: latestEntryGuardStorage.config.exchangeType,
            mode: activeMode,
            modeState,
            notification: latestEntryGuardStorage.runtime.notification,
          });
        }
        entrySignals = entrySignals.filter((entrySignal) => {
          const symbol = String(entrySignal.symbol || "")
            .trim()
            .toUpperCase();
          if (latestConfiguredSymbols.has(symbol)) {
            return true;
          }

          slowTradingShared.entrySignals.addSkipped(skippedEntrySignals, {
            symbol,
            reason:
              `Entry blocked because ${symbol} is no longer in the latest ` +
              "Coin Management Symbols config.",
          });
          return false;
        });
      }

      let volume24hBySymbol: Record<string, number> = {};
      if (
        shouldAutoEnter &&
        entrySignals.length > 0 &&
        (storage.config.maxEntryBased24HourVolPct ?? 0.2) > 0
      ) {
        try {
          const snapshot = await profiler.time("cycle.volume24hRefresh", () =>
            slowTradingMarketVolume.snapshot.refresh({
              exchangeType,
              marketType,
              symbols,
            }),
          );
          volume24hBySymbol = snapshot.volumes;
        } catch (error) {
          tradeLog.error("[slow-trading] failed to refresh 24h volume", error);
          const snapshot = await profiler.time("cycle.volume24hRead", () =>
            slowTradingMarketVolume.snapshot.read(exchangeType, marketType),
          );
          volume24hBySymbol = snapshot?.volumes ?? {};
        }
      }

      if (forcedEntrySymbols.size > 0) {
        const entrySignalSymbols = new Set(
          entrySignals
            .map((signal) =>
              String(signal.symbol || "")
                .trim()
                .toUpperCase(),
            )
            .filter(Boolean),
        );

        for (const symbol of forcedEntrySymbols) {
          if (!entrySignalSymbols.has(symbol)) {
            slowTradingShared.entrySignals.addSkipped(skippedEntrySignals, {
              symbol,
              reason: slowTradingSignals.forcedEntry.getSkipReason({
                symbol,
                configuredSymbols: storage.config.symbols,
                minAbsLevelToEntry:
                  storage.config.minAbsLevelToEntry,
                maxAbsLevelToEntry:
                  storage.config.maxAbsLevelToEntry,
                modeState: executionModeState,
                modelMemoryMap,
              }),
            });
          }
        }
      }

      // E. Try to open new positions when auto-entry is enabled.
      if (shouldAutoEnter && entrySignals.length > 0) {
        // PROD:CAPTURE_ENTRY_STAGE
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
          recommendedPositionsLength: entrySignals.length,
        });

        if (bypass) {
          investAmount = Math.min(investAmount, 10);
        }

        if (investAmount >= trading.constants.MINIMAL_USDT_TO_TRADE) {
          for (const entrySignal of entrySignals) {
            if (slowTradingBlackSwan.runtime.isProtectionPending(activeMode)) {
              slowTradingShared.entrySignals.addSkipped(skippedEntrySignals, {
                symbol: String(entrySignal.symbol || "")
                  .trim()
                  .toUpperCase(),
                reason:
                  "Entry blocked because Black Swan protection activated " +
                  "at the final execution boundary.",
              });
              continue;
            }
            const entrySymbol = String(entrySignal.symbol || "")
              .trim()
              .toUpperCase();
            const entryModelMemory = modelMemoryMap[entrySymbol];

            if (entryGuardMinimumPrice > 0) {
              const latestExecutionPriceBySymbol = await profiler.time(
                "cycle.coinManagementPrices",
                () =>
                  slowTradingMarket.price.buildLatestBySymbol({
                    exchange,
                    marketType,
                    symbols: [entrySymbol],
                  }),
              );
              const latestExecutionPrice =
                latestExecutionPriceBySymbol[entrySymbol];

              if (
                slowTradingAutoRemoveSymbols.price.isBelowMinimum({
                  price: latestExecutionPrice,
                  minimumPrice: entryGuardMinimumPrice,
                })
              ) {
                slowTradingShared.entrySignals.addSkipped(skippedEntrySignals, {
                  symbol: entrySymbol,
                  reason:
                    `Entry blocked because ${entrySymbol}'s fresh price ` +
                    `${latestExecutionPrice} USDT is below the configured ` +
                    `Coin Management minimum of ${entryGuardMinimumPrice} USDT.`,
                });
                continue;
              }
            }

            const report = await profiler.time("cycle.entryExecution", () =>
              trading.execution.entry({
                investAmount,
                entrySignal,
                modelConfig,
                modelMemory: entryModelMemory,
                exchangeType,
                tradingMode,
                bypass,
                notificationTarget: {
                  dashboard: "SLOW",
                  // PROD:NOTIF_ENTRY
                  successKey: "NOTIF_ENTRY",
                  // PROD:NOTIF_ENTRY_FAILED
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
                volume24h:
                  volume24hBySymbol[
                    String(entrySignal.symbol || "")
                      .trim()
                      .toUpperCase()
                  ],
                futuresPositionMode:
                  slowTradingStorage.account.get(storage)
                    ?.futuresPositionMode,
              }),
            );

            reports.push(report);
            executionChecks.push(
              buildStageRunExecutionCheck({
                report,
                symbol: entrySymbol,
              }),
            );

            if (report.tradingDetail?.action === "BUY") {
              slowTradingWatchReserve.volatilityPoint.markUsed({
                entrySignal,
                modelMemory: entryModelMemory,
                roles: bothDirection.config.isEnabled(
                  storage.config.openDirection,
                )
                  ? ["MAIN", "COUNTER"]
                  : undefined,
              });

              dynamicTradeMemory.quoteAsset =
                slowTradingWatchReserve.money.roundUsdt(
                  (dynamicTradeMemory.quoteAsset ?? 0) +
                    report.tradingDetail.usdtSpent,
                );

              slowTradingBalance.reserve.add(
                dynamicTradeMemory,
                slowTradingBalance.reserve.getOpen(entryModelMemory),
              );
            } else {
              slowTradingShared.entrySignals.addSkipped(skippedEntrySignals, {
                symbol: String(entrySignal.symbol || "")
                  .trim()
                  .toUpperCase(),
                reason: report.message,
              });
            }
          }
        } else {
          for (const entrySignal of entrySignals) {
            slowTradingShared.entrySignals.addSkipped(skippedEntrySignals, {
              symbol: String(entrySignal.symbol || "")
                .trim()
                .toUpperCase(),
              reason:
                `Entry budget ${investAmount.toFixed(2)} USDT is below minimum ` +
                `${trading.constants.MINIMAL_USDT_TO_TRADE.toFixed(2)} USDT`,
            });
          }
        }
      }

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
              const hasOpenPositions =
                (modelMemory?.positions ?? []).length > 0;
              if (!hasOpenPositions) {
                return false;
              }

              const hasForceSellPosition = (modelMemory?.positions ?? []).some(
                (position: Position) =>
                  position.control?.forceExit !== undefined,
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
          .map(
            (position: Position): PositionRole =>
              position.role === "COUNTER" ? "COUNTER" : "MAIN",
          );
        const forcedRoles = forcedExitRolesBySymbol.get(
          String(trade.symbol || "")
            .trim()
            .toUpperCase(),
        );
        const roles: Array<PositionRole | undefined> = forcedRoles
          ? Array.from(forcedRoles).filter((role) =>
              positionRoles.includes(role),
            )
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
              futuresPositionMode:
                slowTradingStorage.account.get(storage)
                  ?.futuresPositionMode,
            }),
          );

          reports.push(report);
          executionChecks.push(
            buildStageRunExecutionCheck({
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

      if (
        reports.some((report) => report.tradingDetail?.action === "SELL")
      ) {
        dailyPnlLimitEvaluation = await profiler.time(
          "cycle.dailyPnlLimit",
          () =>
            evaluateCurrentDailyPnlLimit({
              currentTimeMs,
              includePendingArchive: true,
              mode: activeMode,
              modeState: { ...modeState, tradeSettings },
              thresholdUsdt: dailyPnlLimitThresholdUsdt,
            }),
        );
        modeState.dailyPnlLimitState = {
          d: dailyPnlLimitEvaluation.day,
          usdt: dailyPnlLimitEvaluation.pnlUsdt,
        };
        await slowTradingNotifications.dailyPnlLimit.notify({
          currentTimeMs,
          evaluation: dailyPnlLimitEvaluation,
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
        !blackSwanProtectionActive &&
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
        const pairPositions = tradeSettings.flatMap((item) => [
          ...(item.model_memory.positions ?? []),
          ...(item.model_memory.positionsSell ?? []),
        ]);

        const watchResult =
          slowTradingWatchReserve.averaging.generateRecommendations({
            activePositions: allActivePositions,
            pairPositions,
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
          const reservedBefore =
            slowTradingBalance.reserve.getOpen(modelMemory);
          const report = await profiler.time("cycle.averagingExecution", () =>
            trading.execution.averaging({
              symbol: trade.symbol ?? "",
              modelConfig,
              modelMemory,
              volatilityPoints: volatilityPointsMap[trade.symbol ?? ""] ?? [],
              exchangeType,
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
          executionChecks.push(
            buildStageRunExecutionCheck({
              report,
              symbol: trade.symbol ?? "",
            }),
          );

          if (report.tradingDetail?.action === "BUY") {
            const reservedAfter =
              slowTradingBalance.reserve.getOpen(modelMemory);
            slowTradingBalance.reserve.subtract(
              dynamicTradeMemory,
              Math.max(0, reservedBefore - reservedAfter),
            );

            dynamicTradeMemory.quoteAsset =
              slowTradingWatchReserve.money.roundUsdt(
                (dynamicTradeMemory.quoteAsset ?? 0) +
                  report.tradingDetail.usdtSpent,
              );
          }
        }
      }

      // G.2 Replenish a missing streak-break role after exits and averaging.
      if (
        shouldAutoEnter &&
        !dailyPnlLimitEvaluation.reached &&
        bothDirection.config.isEnabled(storage.config.openDirection) &&
        !blackSwanProtectionActive &&
        !slowTradingBlackSwan.runtime.isProtectionPending(activeMode)
      ) {
        const selectedSymbols = new Set(symbols);
        const reentries = tradeSettings.flatMap((tradeSetting) => {
          const symbol = String(tradeSetting.symbol || "")
            .trim()
            .toUpperCase();
          if (!selectedSymbols.has(symbol)) {
            return [];
          }

          const modelMemory = modelMemoryMap[symbol];
          const decision = streakBreak.reentry.resolve({
            positions: modelMemory?.positions ?? [],
            pendingReentries: modelMemory?.pendingReentries,
            volatilityPoints: volatilityPointsMap[symbol] ?? [],
          });
          if (!decision) {
            return [];
          }

          if (decision.status !== "READY" || !decision.point) {
            slowTradingShared.entrySignals.addSkipped(skippedEntrySignals, {
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
          let reentryInvestAmount = brain.algorithms.runtime.getInvestmentAmount({
            dynamicTradeMemory,
            currentBalance,
            allocationPercent: 1,
            recommendedPositionsLength: reentries.length,
          });
          if (bypass) {
            reentryInvestAmount = Math.min(reentryInvestAmount, 10);
          }

          for (const { decision, modelMemory, point, symbol } of reentries) {
            if (
              reentryInvestAmount < trading.constants.MINIMAL_USDT_TO_TRADE
            ) {
              slowTradingShared.entrySignals.addSkipped(skippedEntrySignals, {
                role: decision.role,
                symbol,
                reason:
                  `Re-entry budget ${reentryInvestAmount.toFixed(2)} USDT is below minimum ` +
                  `${trading.constants.MINIMAL_USDT_TO_TRADE.toFixed(2)} USDT`,
              });
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
                investAmount: reentryInvestAmount,
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
                futuresPositionMode:
                  slowTradingStorage.account.get(storage)
                    ?.futuresPositionMode,
                direction: decision.direction,
                pairId: decision.pairId,
                role: decision.role,
              }),
            );
            reports.push(report);
            executionChecks.push(
              buildStageRunExecutionCheck({
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
              dynamicTradeMemory.quoteAsset =
                slowTradingWatchReserve.money.roundUsdt(
                  (dynamicTradeMemory.quoteAsset ?? 0) +
                    report.tradingDetail.usdtSpent,
                );
              const reservedAfter = slowTradingBalance.reserve.getOpen(modelMemory);
              slowTradingBalance.reserve.add(
                dynamicTradeMemory,
                Math.max(0, reservedAfter - reservedBefore),
              );
            } else {
              slowTradingShared.entrySignals.addSkipped(skippedEntrySignals, {
                role: decision.role,
                symbol,
                reason: report.message,
              });
            }
          }
        }
      }

      // H. Refresh final live balance and persist all updated execution state.
      if (!isSandbox) {
        const realQuoteFinal = await profiler.time("cycle.balanceRefresh", () =>
          exchange.getBalance("USDT_USDT"),
        );
        if (realQuoteFinal == null) {
          throw new Error("Can't fetch real balance!");
        }

        dynamicTradeMemory.quoteAsset =
          realQuoteFinal.quoteAsset - dynamicTradeMemory.safeHaven;
      }

      const persistedTradeSymbols = Array.from(
        new Set([
          ...storage.config.symbols,
          ...Object.entries(modelMemoryMap)
            .filter(
              ([, modelMemory]) =>
                (modelMemory?.positions?.length ?? 0) > 0 ||
                (modelMemory?.positionsSell?.length ?? 0) > 0 ||
                (modelMemory?.pendingReentries?.length ?? 0) > 0,
            )
            .map(([symbol]) =>
              String(symbol || "")
                .trim()
                .toUpperCase(),
            )
            .filter(Boolean),
        ]),
      ).sort((a, b) => a.localeCompare(b));

      modeState.tradeSettings = persistedTradeSymbols.map((symbol) => ({
        symbol,
        model_memory: {
          positions: [],
          ...slowTradingShared.clone(modelMemoryMap[symbol] ?? {}),
        },
      }));

      void slowTradingNotifications.openPositions
        .notify({
          positions: slowTradingPositions.active.withTradeSymbols(
            modeState.tradeSettings,
          ),
          volatilityPointsMap,
          exchangeType,
          mode: activeMode,
          notification: storage.runtime.notification,
          currentTimeMs,
        })
        .catch((notificationError) => {
          tradeLog.error(
            "[slow-trading] failed to notify open positions",
            notificationError,
          );
        });

      if (shouldMonitor) {
        const reportingSymbolSet = new Set(symbols);
        const reportingSymbols = modeState.tradeSettings
          .filter(
            (tradeSetting) =>
              reportingSymbolSet.has(
                String(tradeSetting.symbol || "")
                  .trim()
                  .toUpperCase(),
              ) && (tradeSetting.model_memory.positions?.length ?? 0) > 0,
          )
          .map((tradeSetting) => tradeSetting.symbol);
        const [latestPriceBySymbol, fundingRateBySymbol] =
          reportingSymbols.length > 0
            ? await Promise.all([
                profiler.time("cycle.latestPrices", () =>
                  slowTradingMarket.price.buildLatestBySymbol({
                    exchange,
                    marketType,
                    symbols: reportingSymbols,
                  }),
                ),
                tradingMode === TradingMode.FUTURES
                  ? profiler
                      .time("cycle.fundingRates", () =>
                        exchangeFundingRate.latest.map({
                          exchangeType,
                          tradingMode,
                          symbols: reportingSymbols,
                        }),
                      )
                      .catch((fundingError) => {
                        // Funding is supplementary monitoring data. Never let a
                        // failed public snapshot stop position management.
                        tradeLog.error(
                          "[slow-trading] failed to refresh position funding rates",
                          fundingError,
                        );
                        return {};
                      })
                  : Promise.resolve({}),
              ])
            : [{}, {}];
        // PROD:MONITORING_OPEN_POSITION
        await profiler.time("cycle.reportingSync", () =>
          slowTradingReporting.modeState.sync({
            exchangeType,
            fundingRateBySymbol,
            historyBucketMinutes: storage.runtime.pnlHistoryBucketMinutes,
            modeState,
            latestPriceBySymbol,
            currentTimeMs,
            updatedAtMs: Date.now(),
            monitoring: monitoringStage
              ? {
                  stage: monitoringStage,
                  reasonByPosition: monitoringReasonByPosition,
                }
              : undefined,
          }),
        );
      }

      modeState.dynamicTradeMemory = {
        ...slowTradingShared.clone(dynamic.defaults.tradingMemory),
        ...slowTradingShared.clone(dynamicTradeMemory),
      };
      const lastRunSummary =
        `${activeMode}${stage ? ` ${stage}` : ""} cycle finished with ${reports.length} report(s)` +
        ` | auto entry ${shouldAutoEnter ? "on" : "off"}` +
        ` | auto exit ${shouldAutoExit ? "on" : "off"}`;
      const stageRunChecks = buildStageRunChecks({
        executionChecks,
        skippedEntries: skippedEntrySignals,
      });
      slowTradingStageRun.recordCompleted({
        cycleStartedAt,
        modeState,
        performanceEntries,
        reports: reports.length,
        checks: stageRunChecks,
        stage,
        summary: lastRunSummary,
        symbols: symbols.length,
      });

      // H.1 Persist cache files, then persist the mode snapshot itself.
      await profiler.time("cycle.cachePersist", () =>
        slowTradingCache.modeState.persistCaches({
          exchangeType,
          modeState,
        }),
      );
      storage.modes[activeMode] = modeState;
      await profiler.time("cycle.modeStatePersist", () =>
        slowTradingStorage.mode.saveState(activeMode, modeState),
      );

      // Report the previous fully closed UTC day after its trades are archived.
      await slowTradingNotifications.dailyPerformance.notify({
        currentTimeMs: Date.now(),
        exchangeType,
        mode: activeMode,
        modeState,
        notification: storage.runtime.notification,
      });

      slowTradingStageRun.recordCompleted({
        cycleStartedAt,
        modeState,
        performanceEntries,
        reports: reports.length,
        checks: stageRunChecks,
        stage,
        summary: lastRunSummary,
        symbols: symbols.length,
      });
      storage.modes[activeMode] = modeState;
      await slowTradingStorage.mode.saveState(activeMode, modeState);

      // H.2 Calculate total asset and capture daily snapshot.
      let totalLockedQuoteAsset = 0;
      for (const tradeSetting of modeState.tradeSettings) {
        for (const pos of tradeSetting.model_memory.positions ?? []) {
          totalLockedQuoteAsset +=
            slowTradingWatchReserve.balance.getLockedQuoteAssetValue({
              activePositions: [pos],
            });
        }
      }

      const availableQuoteAsset =
        (modeState.dynamicTradeMemory.quoteAsset ?? 0) +
        (modeState.dynamicTradeMemory.safeHaven ?? 0);
      const snapshotTotal = availableQuoteAsset + totalLockedQuoteAsset;

      void slowTradingStorage.balanceSnapshots.upsert({
        mode: activeMode as SlowTradingMode,
        total: snapshotTotal,
        timestamp: currentTimeMs,
      });

      return {
        mode: activeMode as SlowTradingMode,
        stage,
        symbols,
        reports,
        executedEntrySignals: reports.filter(
          (report) => report.tradingDetail?.action === "BUY",
        ).length,
        skippedEntrySignals,
        availableQuoteAsset,
        lastRunAt: modeState.lastRunAt,
        lastRunDurationMs: modeState.lastRunDurationMs,
      };
    }),
  );
}

/**
 * Queues a SLOW cycle so runner and manual API mutations cannot overwrite each
 * other's balance, position, cache, or mode-state persistence.
 */
export function runSlowTradingCycle(params?: RunSlowTradingCycleParams) {
  return slowTradingMutationQueue.runExclusive(() =>
    executeSlowTradingCycle(params),
  );
}

/**
 * Grouped cycle API for executing SLOW trading service work.
 */
const slowTradingCycle = {
  run: runSlowTradingCycle,
  runSlowTradingCycle,
} as const;

export default slowTradingCycle;
export { slowTradingCycle };
