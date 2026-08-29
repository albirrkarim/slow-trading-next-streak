import type {
  ExchangeType,
  UnifiedFuturesPositionMode,
  UnifiedOrderParams,
} from "@/lib/exchange";
import {
  getExchange,
  TradingMode,
  UnifiedOrderSide,
  UnifiedOrderType,
} from "@/lib/exchange";
import type {
  TradeDecision,
  TradingModelConfig,
  TradingModelMemory,
  Position,
  PositionAveragingState,
  PositionEntrySourceOverride,
  PositionRole,
} from "@/lib/trading/models";
import moment from "moment-timezone";
import type { EntryRecommendation } from "../../brain/algorithms/type-execute";
import { decisionEngineLevelConfig } from "../../brain/algorithms/v4/decisions/v19/constants";
import type { Kline } from "../../exchange/platform/tokocrypto";
import { tradeLog } from "../helper/log";
import { notif } from "../helper/notification"; // Email/notification system
import type { NotificationDashboard } from "@/lib/notification/config";
import { TRADE_MESSAGE } from "../message";
import type { InitialBalance, TradingDetail, TradingReturn } from "../type"; // Config & return types
import { dynamicEntry } from "./models/entry";
import type { DynamicTradeConfig } from "@/lib/dynamic";
import { resolveEntryLeverage } from "./entry-leverage";
import entryFunding from "./entry-funding";
import entryOpenPositionGuard from "./entry-open-position-guard";
import lateEntryVPointDrift from "./late-entry-vpoint-drift";
import entryMarket from "./entry-market";
import { buildSlowWatchReserveState } from "../../slowTrading/watch-reserve";
import tradingPosition from "../position";
import bothDirection from "../both-direction";

export interface ExecuteEntryProps {
  investAmount: number;
  entrySignal: EntryRecommendation;
  current?: Kline;
  modelConfig: TradingModelConfig;
  modelMemory: TradingModelMemory;
  exchangeType: ExchangeType;
  tradingMode: TradingMode;
  bypass?: boolean;
  simulate?: boolean;
  balanceOverride?: InitialBalance;
  executionMode?: "live" | "sandbox";
  notificationTarget?: {
    dashboard: NotificationDashboard;
    successKey: string;
    failureKey: string;
  };
  reservedQuoteAsset?: number;
  dynamicTradeConfig: DynamicTradeConfig;
  allModelMemories?: TradingModelMemory[];
  volume24h?: number;
  futuresPositionMode?: UnifiedFuturesPositionMode;
  /** Internal controls used while coordinating an atomic two-leg entry. */
  internalLeg?: {
    direction: Position["direction"];
    fundingWorkerLegs?: number;
    pairId?: string;
    replenishPair?: boolean;
    role: PositionRole;
    suppressNotification?: boolean;
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function buildPersistedEntryFeature(entrySignal: EntryRecommendation) {
  const feature =
    entrySignal.feature && typeof entrySignal.feature === "object"
      ? cloneJson(entrySignal.feature)
      : {};

  return Object.keys(feature).length > 0 ? feature : undefined;
}

function buildEmptyAveragingState(
  entryLevel: number,
  baseMarginUsdt: number,
): PositionAveragingState {
  return {
    entryLevel,
    lastHandledLevel: entryLevel,
    reserveBaseMarginUsdt: baseMarginUsdt,
    reservedRemainingMarginUsdt: 0,
    steps: [],
  };
}

function removeRetainedClosedRole(params: {
  modelMemory: TradingModelMemory;
  pairId?: string;
  role?: PositionRole;
}) {
  if (!params.pairId || !params.role) {
    return;
  }

  params.modelMemory.positions = (params.modelMemory.positions ?? []).filter(
    (position) =>
      !(
        position.closed &&
        bothDirection.pair.resolveId(position) === params.pairId &&
        bothDirection.position.role.resolve(position) === params.role
      ),
  );
}

function resolveEntrySource(
  bypass: boolean,
  category?: string,
): PositionEntrySourceOverride | undefined {
  if (bypass) return "BYPASS";
  return category?.includes("MANUAL") ? "MANUAL" : undefined;
}

export function calculateExecutedEntryAccounting(params: {
  feeRate: number;
  leverage: number;
  price: number;
  quantity: number;
  tradingMode: TradingMode;
}) {
  const price = Number.isFinite(params.price) ? params.price : 0;
  const quantity = Number.isFinite(params.quantity) ? params.quantity : 0;
  const leverage = Math.max(
    1,
    Number.isFinite(params.leverage) ? params.leverage : 1,
  );
  const feeRate = Number.isFinite(params.feeRate)
    ? Math.max(0, params.feeRate)
    : 0;
  const notionalUSDT = quantity * price;
  const feeUSDT = notionalUSDT * feeRate;
  const marginUSDT =
    params.tradingMode === TradingMode.SPOT
      ? notionalUSDT
      : notionalUSDT / leverage;

  return {
    feeUSDT,
    marginUSDT,
    notionalUSDT,
    quoteSpentUSDT: marginUSDT + feeUSDT,
  };
}

export async function executeEntry({
  investAmount,
  current, // Current candle (last minute)
  entrySignal,
  modelConfig, // Strategy configuration,
  modelMemory,
  exchangeType = "tokocrypto",
  tradingMode = TradingMode.SPOT,
  bypass = false,
  simulate = false,
  balanceOverride,
  executionMode = "live",
  notificationTarget,
  reservedQuoteAsset = 0,
  dynamicTradeConfig,
  allModelMemories,
  volume24h,
  futuresPositionMode,
  internalLeg,
}: ExecuteEntryProps): Promise<TradingReturn> {
  const { orderType = "taker", onlyTPFromDate } = modelConfig; // Default to taker orders (market)

  if (!modelMemory.positions) {
    // Save buy record, to track the price
    modelMemory.positions = [] as Position[];
  }

  const isTest = simulate;
  const symbol = entrySignal.symbol ?? "";

  if (
    !internalLeg &&
    bothDirection.config.isEnabled(dynamicTradeConfig.openDirection)
  ) {
    return executeBothDirectionEntry({
      investAmount,
      current,
      entrySignal,
      modelConfig,
      modelMemory,
      exchangeType,
      tradingMode,
      bypass,
      simulate,
      balanceOverride,
      executionMode,
      notificationTarget,
      reservedQuoteAsset,
      dynamicTradeConfig,
      allModelMemories,
      volume24h,
      futuresPositionMode,
    });
  }
  const activePositions =
    (allModelMemories?.flatMap((memory) => memory.positions ?? []) ??
      modelMemory.positions).filter((position) => !position.closed);
  const openPositionGuard = entryOpenPositionGuard.evaluate({
    maxOpenPositions: dynamicTradeConfig.maxOpenPositions,
    positions: activePositions,
  });

  // BOTH:MAX_OPEN_POSITIONS_ENTRY_GUARD
  if (
    openPositionGuard.blocked &&
    internalLeg?.role !== "COUNTER" &&
    !internalLeg?.replenishPair
  ) {
    return {
      symbol: entrySignal.symbol,
      message: openPositionGuard.reason!,
    };
  }

  if (
    !decisionEngineLevelConfig.isEntryLevel(
      entrySignal,
      dynamicTradeConfig.minAbsLevelToEntry,
      dynamicTradeConfig.maxAbsLevelToEntry,
    )
  ) {
    const minAbsLevelToEntry =
      decisionEngineLevelConfig.resolveMinAbsLevelToEntry(
        dynamicTradeConfig.minAbsLevelToEntry,
      );
    const maxAbsLevelToEntry =
      decisionEngineLevelConfig.resolveMaxAbsLevelToEntry(
        dynamicTradeConfig.maxAbsLevelToEntry,
      );
    return {
      symbol: entrySignal.symbol,
      message:
        `[ENTRY_OUTSIDE_ABS_LEVEL_RANGE] Entry skipped because ${symbol || "unknown"} ` +
        `level ${entrySignal.lvl ?? "unknown"} is outside configured absolute range ` +
        `${minAbsLevelToEntry}-${maxAbsLevelToEntry}`,
    };
  }

  const tradingSymbol = symbol.includes("_") ? symbol : symbol + "_USDT";

  const exchange = getExchange(exchangeType, {
    defaultTradingMode: tradingMode,
    futuresPositionMode,
  });

  const baseAssetSymbol = symbol;
  const quoteAssetSymbol = "USDT";

  let currentBalance = undefined;

  // A.0 Get real quote and base
  const realBalance =
    balanceOverride ?? (await exchange.getBalance(tradingSymbol));
  if (realBalance == null) {
    return {
      symbol: entrySignal.symbol,
      message: `Can't fetch real balance! ${tradingSymbol}`,
    };
  }

  // A.1 Quote Asset To Trade
  if (modelMemory.quoteAssetToTrade !== undefined) {
    currentBalance = {
      ...realBalance,
      quoteAsset: modelMemory.quoteAssetToTrade,
    };
  } else {
    // A.2 model passive and older
    currentBalance = realBalance;
  }

  tradeLog.debug("Real Balance ", currentBalance);

  if (!currentBalance) {
    tradeLog.error("Balance not defined");
    return {
      symbol: entrySignal.symbol,
      message: "Balance not defined",
    };
  }

  /**
   * C. Fetch fresh candles whenever the caller did not provide one.
   *    Sandbox mode still needs a live market price even though execution is simulated.
   */
  if (!current) {
    current = await entryMarket.currentKline.getLatest({
      exchange,
      symbol,
      tradingMode,
    });
  }

  if (!current) {
    tradeLog.error("current undefined, Empty kline data");
    return {
      symbol: entrySignal.symbol,
      message: "Current kline undefined",
    };
  }

  /**
   * in USDT
   */
  let totalFee = 0;
  let totalTax = 0;
  const totalProfit = 0;

  /**
   * In Percentage
   */
  const totalProfitPercent = 0;

  // Determine order type: taker = MARKET, maker = LIMIT
  const orderTypeCode =
    orderType === "taker" ? UnifiedOrderType.MARKET : UnifiedOrderType.LIMIT;

  // Current price from OHLCV (close price)
  const price = parseFloat(current[4]);

  const lastVolatility = modelMemory.volatility?.lastVolatility.at(-1);
  const direction =
    internalLeg?.direction ??
    (tradingMode == TradingMode.SPOT
      ? "LONG"
      : lastVolatility?.l === "T"
        ? "SHORT"
        : "LONG");

  const lateEntryGuard = lateEntryVPointDrift.evaluateEntry({
    bothDirection: bothDirection.config.isEnabled(
      dynamicTradeConfig.openDirection,
    ),
    currentPrice: price,
    direction,
    vPointPrice: entrySignal.p,
  });

  // PROD:LATE_ENTRY_VPOINT_PRICE_DRIFT_PCT
  if (lateEntryGuard.blocked) {
    return {
      symbol: entrySignal.symbol,
      message: lateEntryGuard.reason!,
    };
  }

  // Real success order or not,
  let success = false;
  let tradingResult = undefined;
  let usdtSpent = 0;

  const requestedMarginUsdt = entryFunding.requestedMargin.resolve({
    bypass,
    exchangeType,
    investAmount,
    maxUsdtEntry: entrySignal.maxUsdtEntry,
    probability: entrySignal.amountProbab,
  });

  let leverage = 1;

  if (tradingMode === TradingMode.FUTURES) {
    leverage = resolveEntryLeverage({
      entrySignal,
      tradingMode,
      config: dynamicTradeConfig,
    });

    // PROD:FUTURES_ENTRY_ACCOUNT_SETUP
    // Sandbox shares leverage math with live trading but must not mutate the exchange account.
    if (!isTest) {
      const leverageSet = await exchange.setLeverage(tradingSymbol, leverage);

      if (!leverageSet) {
        throw new Error(
          `Failed to configure futures leverage and isolated margin for ${tradingSymbol} at ${leverage}x`,
        );
      }

      tradeLog.log(
        `[ExecuteEntry] Leverage set to ${leverage}x for ${tradingSymbol} amountProbab: ${entrySignal.amountProbab}`,
      );
    }
  }

  modelConfig.balanceUSDT = requestedMarginUsdt;

  const decision: TradeDecision = await dynamicEntry({
    symbol,
    current,
    config: {
      ...modelConfig,
      minAbsLevelToEntry: dynamicTradeConfig.minAbsLevelToEntry,
      maxAbsLevelToEntry: dynamicTradeConfig.maxAbsLevelToEntry,
    },
    memory: modelMemory,
    bypass,
  });

  const entryVPoint = {
    ...(decision.entryVPoint ?? {
      id: entrySignal.id,
      lvl: entrySignal.lvl ?? 0,
    }),
    t: entrySignal.t,
  };

  tradeLog.log("\n\n Decision ", decision);

  let message = decision.log ?? decision.reason ?? "-";

  /**
   * F. Execute BUY logic (new entry only — no averaging)
   */
  if (decision.action === "BUY" && !modelMemory.forceSell) {
    const quoteAssetBefore = currentBalance.quoteAsset;

    /**
     * Get the amount of USDT from model suggestion or the all in with all USDT asset in balance
     */
    const requestedDecisionMarginUsdt =
      decision.amount ?? quoteAssetBefore;

    // Calculate total buy fee early because futures reserve fitting is based on margin.
    const totalFeePercent = exchange.getFees().getTotalFeePercent({
      side: "buy",
      currency: quoteAssetSymbol,
      type: orderType as "maker" | "taker",
    });

    const totalFeeRate = totalFeePercent / 100;
    const fundingPlan = entryFunding.plan.calculate({
      activePositions,
      config: dynamicTradeConfig,
      direction,
      entryLevel: entryVPoint.lvl,
      feeRate: totalFeeRate,
      leverage,
      requestedMarginUsdt: requestedDecisionMarginUsdt,
      reservedQuoteAsset,
      spendableQuoteAsset: quoteAssetBefore,
      tradingMode,
      volume24h,
      workerLegs: internalLeg?.fundingWorkerLegs,
    });
    const amountToBuy = fundingPlan.adjustedNotionalUsdt;

    if (fundingPlan.blockReason) {
      return {
        symbol: entrySignal.symbol,
        message: fundingPlan.blockReason,
      };
    }

    // We will calculate usdtSpent and quoteStill after calculating fees

    // F.1 Only TP from defined date
    if (onlyTPFromDate) {
      const targetMoment = moment(onlyTPFromDate, "M/D/YYYY");
      const now = moment(current[0]);
      if (now.isAfter(targetMoment)) {
        return {
          symbol: entrySignal.symbol,
          message: `${TRADE_MESSAGE.buy.NO_MORE_AFTER_DATE} We can only sell to TP from ${onlyTPFromDate} no more buy!`,
        };
      }
    }

    // F.2 Start to buy

    const estimatedFeeAmount = fundingPlan.estimatedFeeUsdt;
    const availableSaldo = fundingPlan.availableNotionalUsdt;
    const enableWatchLogic = dynamicTradeConfig.enableWatchLogic !== false;
    const watchReserveLevels = dynamicTradeConfig.watchReserveLevels ?? 2;
    const watchReservePctAlloc =
      dynamicTradeConfig.watchReservePctAlloc ?? 2;

    const preferredQuantity = availableSaldo / price;

    // Quantity of base asset (BTC) to buy
    const quantity = await exchange.adjustQuantity(
      preferredQuantity,
      tradingSymbol,
    );

    if (quantity == 0) {
      return {
        symbol: entrySignal.symbol,
        message: `${TRADE_MESSAGE.cancel.amount.NO_ENOUGH} No enough balance to buy! preferredQuantity:${preferredQuantity} amountToBuy:${amountToBuy} fee:${estimatedFeeAmount} tax:0 availableSaldo:${availableSaldo}`,
      };
    }

    const executedAccounting = calculateExecutedEntryAccounting({
      feeRate: totalFeeRate,
      leverage,
      price,
      quantity,
      tradingMode,
    });
    usdtSpent = -executedAccounting.quoteSpentUSDT;
    const quoteStill = quoteAssetBefore - executedAccounting.quoteSpentUSDT;
    const actualWatchState = enableWatchLogic
      ? buildSlowWatchReserveState({
          direction,
          baseMarginUsdt: executedAccounting.marginUSDT,
          entryLevel: entryVPoint.lvl,
          reserveLevels: watchReserveLevels,
          maxNextLevels:
            dynamicTradeConfig.watchMaxNextAveragingLevels ??
            watchReserveLevels,
          pctAlloc: watchReservePctAlloc,
        })
      : undefined;

    // Update position (sandbox simulation)
    if (isTest) {
      removeRetainedClosedRole({
        modelMemory,
        pairId: internalLeg?.pairId,
        role: internalLeg?.role,
      });
      modelMemory.positions.push({
        symbol,
        pairId: internalLeg?.pairId,
        role: internalLeg?.role ?? "MAIN",
        executionMode,
        tradingMode,
        direction,
        opened: {
          t: current[0],
          vPoint: entryVPoint,
          source: resolveEntrySource(bypass, decision.category),
          reason: tradingPosition.entry.reason.resolve(decision.category),
          message,
          price,
        },
        exposure: {
          quantity,
          averageEntryPrice: price,
          notionalUsdt: executedAccounting.notionalUSDT,
          marginUsdt: executedAccounting.marginUSDT,
          leverage,
        },
        fees: {
          entryUsdt: executedAccounting.feeUSDT,
          estimatedExitUsdt: executedAccounting.feeUSDT,
        },
        strategy: {
          entry: {
            engine: dynamicTradeConfig.decisionEngineVersion as
              | Position["strategy"]["entry"]["engine"]
              | undefined,
            feature: buildPersistedEntryFeature(entrySignal),
            label: decision.category?.replaceAll("[", "").replaceAll("]", ""),
          },
          averaging:
            actualWatchState ??
            buildEmptyAveragingState(
              entryVPoint.lvl,
              executedAccounting.marginUSDT,
            ),
        },
        pnl: {},
      });

      const sandboxMessage = `[SANDBOX] ${TRADE_MESSAGE.buy.ENTRY} | ${symbol} ${direction}
        | USDT: $${executedAccounting.notionalUSDT.toFixed(2)} @ Price: $${price.toFixed(5)}
        | Quantity: ${quantity}
        | ${tradingMode == TradingMode.FUTURES ? `Leverage: ${leverage}x` : ""}
        | ${exchangeType}:${tradingMode}
        `;
      const body = JSON.stringify(
        {
          modelDecision: {
            decision,
            requestedDecisionMarginUsdt,
            amountToBuy,
            quoteAssetBefore,
            availableSaldo,
            price,
            preferredQuantity,
            quantity,
          },
          sandbox: true,
        },
        null,
        2,
      );

      if (internalLeg?.suppressNotification) {
        // The pair coordinator reports only after both legs succeed.
      } else if (notificationTarget) {
        void notif.central({
          dashboard: notificationTarget.dashboard,
          // PROD:NOTIF_ENTRY
          key: notificationTarget.successKey,
          title: sandboxMessage,
          message: body,
        });
      } else {
        void notif.central({
          subject: sandboxMessage,
          body,
        });
      }
    }

    // Update balances
    totalFee = executedAccounting.feeUSDT;
    totalTax = 0; // Unified interface aggregates tax into fee, or assumes 0 if not exposed

    currentBalance.baseAsset = quantity;
    currentBalance.quoteAsset = quoteStill;

    // Place order on live exchange
    if (!isTest) {
      const buyParam: UnifiedOrderParams = {
        // PROD:HEDGE_ORDER_POSITION_SIDE
        tradeType: "ENTRY",
        symbol: tradingSymbol,
        side:
          direction === "LONG" ? UnifiedOrderSide.BUY : UnifiedOrderSide.SELL,
        type: orderTypeCode,
        quantity,
        price,
        tradingMode,
        positionSide:
          tradingMode === TradingMode.FUTURES &&
          futuresPositionMode === "HEDGE"
            ? direction.toLowerCase() as "long" | "short"
            : undefined,
        // timeInForce handled in adapter for LIMIT orders
      };

      let liveOrderPlaced = false;
      try {
        tradeLog.log("BUY Params:", buyParam);

        const buyResult = await exchange.createOrder(buyParam);
        liveOrderPlaced = true;

        tradeLog.log("BUY Result:", JSON.stringify(buyResult, null, 2));

        // Real data from exchange
        const executedPrice = buyResult.executedPrice || price;
        let executedQty = buyResult.executedQty || 0;

        // If adapter didn't return executedQty (e.g. OKX Market Buy), try to fetch it
        if (!executedQty || executedQty === 0) {
          try {
            // Wait a moment for order to process/fill
            await new Promise((r) => setTimeout(r, 2000));
            const lastOrder = await exchange.getLastOrder(tradingSymbol);
            if (lastOrder && lastOrder.orderId === buyResult.orderId) {
              executedQty = lastOrder.executedQty || 0;
              tradeLog.log(
                `[ExecuteEntry] Fetched updated executedQty: ${executedQty}`,
              );
            }
          } catch (e) {
            tradeLog.warn("Failed to fetch executedQty update", e);
          }
        }

        // Fallback to calculated quantity if still 0
        if (executedQty === 0) {
          executedQty = quantity;
        }

        const executedQuoteQty = executedPrice * executedQty;
        const liveMarginUSDT =
          tradingMode === TradingMode.SPOT
            ? executedQuoteQty
            : executedQuoteQty / leverage;

        const liveWatchState = enableWatchLogic
          ? buildSlowWatchReserveState({
              direction,
              baseMarginUsdt: liveMarginUSDT,
              entryLevel: entryVPoint.lvl,
              reserveLevels: watchReserveLevels,
              maxNextLevels:
                dynamicTradeConfig.watchMaxNextAveragingLevels ??
                watchReserveLevels,
              pctAlloc: watchReservePctAlloc,
            })
          : undefined;
        const entryMessage = `${TRADE_MESSAGE.buy.ENTRY} | ${symbol} ${direction}
        | USDT: $${executedQuoteQty.toFixed(
          2,
        )} @ Price: $${executedPrice.toFixed(5)}
        | Quantity: ${executedQty}
        | ${tradingMode == TradingMode.FUTURES ? `Leverage: ${leverage}x` : ""}
        | ${exchangeType}:${tradingMode}
        `;

        removeRetainedClosedRole({
          modelMemory,
          pairId: internalLeg?.pairId,
          role: internalLeg?.role,
        });
        modelMemory.positions.push({
          symbol,
          pairId: internalLeg?.pairId,
          role: internalLeg?.role ?? "MAIN",
          executionMode,
          tradingMode,
          direction,
          opened: {
            t: current[0],
            vPoint: entryVPoint,
            source: resolveEntrySource(bypass, decision.category),
            reason: tradingPosition.entry.reason.resolve(decision.category),
            message: entryMessage,
            price: executedPrice,
          },
          exposure: {
            quantity: executedQty,
            averageEntryPrice: executedPrice,
            notionalUsdt: executedQuoteQty,
            marginUsdt: liveMarginUSDT,
            leverage,
          },
          fees: {
            entryUsdt: executedQuoteQty * totalFeeRate,
            estimatedExitUsdt: executedQuoteQty * totalFeeRate,
          },
          strategy: {
            entry: {
              engine: dynamicTradeConfig.decisionEngineVersion as
                | Position["strategy"]["entry"]["engine"]
                | undefined,
              feature: buildPersistedEntryFeature(entrySignal),
              label: decision.category
                ?.replaceAll("[", "")
                .replaceAll("]", ""),
            },
            averaging:
              liveWatchState ??
              buildEmptyAveragingState(entryVPoint.lvl, liveMarginUSDT),
          },
          pnl: {},
        });

        // The exchange fill and its local recovery record now both exist.
        success = true;

        tradingResult = buyResult;

        message = entryMessage;

        // Send notification email
        const body = JSON.stringify(
          {
            modelDecision: {
              decision,
              requestedDecisionMarginUsdt,
              amountToBuy,
              quoteAssetBefore,
              availableSaldo,
              price,
              preferredQuantity,
              quantity,
            },
            buyParam,
            buyResult,
          },
          null,
          2,
        );

        if (internalLeg?.suppressNotification) {
          // The pair coordinator reports only after both legs succeed.
        } else if (notificationTarget) {
          void notif.central({
            dashboard: notificationTarget.dashboard,
            // PROD:NOTIF_ENTRY
            key: notificationTarget.successKey,
            title: message,
            message: body,
          });
        } else {
          void notif.central({
            subject: message,
            body,
          });
        }
      } catch (error: any) {
        tradeLog.error("BUY Failed:", error);

        let rollbackFailure: unknown;
        if (
          liveOrderPlaced &&
          internalLeg &&
          tradingMode === TradingMode.FUTURES
        ) {
          try {
            await exchange.closePosition(tradingSymbol, {
              direction,
              tradingMode,
            });
            const confirmation = await exchange.ensureClosed({
              direction,
              positionSide: direction.toLowerCase() as "long" | "short",
              symbol: tradingSymbol,
            });
            if (!confirmation.closed) {
              throw new Error(
                `${direction} cleanup retained ${confirmation.remainingAmount}`,
              );
            }
          } catch (rollbackError) {
            rollbackFailure = rollbackError;
          }
        }
        success = false;

        // Send notification email for failure
        const body = JSON.stringify({
          modelDecision: {
            decision,
            amountToBuy,
          },
          buyParam,
          error: error.message || error,
        });

        if (internalLeg?.suppressNotification) {
          // The pair coordinator reports one failure for the complete pair.
        } else if (notificationTarget) {
          void notif.central({
            dashboard: notificationTarget.dashboard,
            // PROD:NOTIF_ENTRY_FAILED
            key: notificationTarget.failureKey,
            title: "BUY ORDER FAILED",
            message: body,
          });
        } else {
          void notif.central({
            subject: "BUY ORDER FAILED",
            body,
          });
        }

        message =
          error.message +
          (rollbackFailure
            ? `; filled-order cleanup failed: ${rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure)}`
            : liveOrderPlaced && internalLeg
              ? "; filled order was closed"
              : "");

        tradingResult = { error: error.message };
      }
    }
  }

  let tradingDetail: TradingDetail | undefined = undefined;

  if (decision.action !== "HOLD") {
    tradingDetail = {
      baseAssetSymbol,
      action: decision.action,
      finalBalance: currentBalance.quoteAsset,
      usdtSpent,
      totalFee,
      totalTax,
      totalProfit,
      totalProfitPercent,
    };
  }

  /**
   * H. Return trade result summary
   */
  return {
    symbol: entrySignal.symbol,
    message,
    tradingDetail: isTest ? tradingDetail : success ? tradingDetail : undefined,
    tradingResult,
  };
}

async function validateBothDirectionEntry(
  params: Pick<
    ExecuteEntryProps,
    | "exchangeType"
    | "futuresPositionMode"
    | "simulate"
    | "tradingMode"
  >,
): Promise<string | undefined> {
  if (
    params.tradingMode !== TradingMode.FUTURES ||
    params.exchangeType !== "binance"
  ) {
    return "[ENTRY_BOTH_DIRECTION] Both-direction entry requires Binance Futures";
  }

  // PROD:VALIDATE_HEDGE_POSITION_MODE_SANDBOX
  if (params.futuresPositionMode !== "HEDGE") {
    return "[VALIDATE_HEDGE_POSITION_MODE] Both-direction entry requires account futuresPositionMode HEDGE";
  }

  const exchange = getExchange(params.exchangeType, {
    defaultTradingMode: params.tradingMode,
    futuresPositionMode: params.futuresPositionMode,
  });
  if (!params.simulate) {
    // PROD:VALIDATE_HEDGE_POSITION_MODE_LIVE
    let authoritativeMode: UnifiedFuturesPositionMode | undefined;
    try {
      authoritativeMode = await exchange.getFuturesPositionMode?.();
    } catch (error) {
      return `[VALIDATE_HEDGE_POSITION_MODE] Unable to validate Binance Hedge Mode: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (authoritativeMode !== "HEDGE") {
      return `[VALIDATE_HEDGE_POSITION_MODE] Binance account mode is ${authoritativeMode ?? "unavailable"}; expected HEDGE`;
    }
  }

  return undefined;
}

async function executeBothDirectionEntry(
  params: ExecuteEntryProps,
): Promise<TradingReturn> {
  const symbol = params.entrySignal.symbol ?? "";
  const validationError = await validateBothDirectionEntry(params);
  if (validationError) {
    return { symbol, message: validationError };
  }

  const exchange = getExchange(params.exchangeType, {
    defaultTradingMode: params.tradingMode,
    futuresPositionMode: params.futuresPositionMode,
  });

  const mainDirection = params.entrySignal.l === "T" ? "SHORT" : "LONG";
  const legs = bothDirection.entry.resolveLegs({
    mainDirection,
    openDirection: "BOTH",
  });
  const pairId = bothDirection.entry.pairId.build({
    symbol,
    opened: {
      t: params.entrySignal.t,
      vPoint: {
        id: params.entrySignal.id,
      },
    },
  });
  const positionsBefore = cloneJson(params.modelMemory.positions ?? []);
  const reports: TradingReturn[] = [];
  let sandboxBalance = params.balanceOverride;

  for (const [index, leg] of legs.entries()) {
    const report = await executeEntry({
      ...params,
      balanceOverride: sandboxBalance,
      dynamicTradeConfig: {
        ...params.dynamicTradeConfig,
        openDirection: "BOTH",
        ...(index > 0 && reports[0]?.tradingDetail
          ? {
              maxEntryMargin:
                params.modelMemory.positions?.find(
                  (position) => position.role === "MAIN" && !position.closed,
                )?.exposure.marginUsdt ?? params.dynamicTradeConfig.maxEntryMargin,
            }
          : {}),
      },
      internalLeg: {
        direction: leg.direction,
        fundingWorkerLegs: index === 0 ? legs.length : 1,
        pairId,
        role: leg.role,
        suppressNotification: true,
      },
    });
    reports.push(report);

    if (!report.tradingDetail || report.tradingDetail.action !== "BUY") {
      const opened = (params.modelMemory.positions ?? []).filter(
        (position) =>
          !positionsBefore.some(
            (before) =>
              before.opened.t === position.opened.t &&
              before.opened.vPoint.id === position.opened.vPoint.id &&
              before.role === position.role,
          ),
      );
      let rollbackError: unknown;
      if (!params.simulate) {
        for (const position of opened) {
          try {
            await exchange.closePosition(
              symbol.includes("_") ? symbol : `${symbol}_USDT`,
              {
                direction: position.direction,
                tradingMode: params.tradingMode,
              },
            );
            const confirmation = await exchange.ensureClosed({
              direction: position.direction,
              positionSide: position.direction.toLowerCase() as
                | "long"
                | "short",
              symbol: symbol.includes("_") ? symbol : `${symbol}_USDT`,
            });
            if (!confirmation.closed) {
              throw new Error(
                `${position.direction} rollback retained ${confirmation.remainingAmount}`,
              );
            }
          } catch (error) {
            rollbackError = error;
          }
        }
      }
      if (rollbackError) {
        for (const position of opened) {
          position.control ??= {};
          position.control.forceExit = {
            reason: "Paired entry rollback failed; retry the partial-leg exit",
            closeReason: "FORCED",
          };
        }
      } else {
        params.modelMemory.positions = positionsBefore;
      }
      const reason =
        `[ENTRY_BOTH_DIRECTION] Pair entry failed on ${leg.role} ${leg.direction}: ${report.message}` +
        (rollbackError
          ? `; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
          : opened.length > 0
            ? "; filled leg rolled back"
            : "; no leg was filled");
      return { symbol, message: reason, tradingResult: { error: reason } };
    }

    if (params.simulate) {
      sandboxBalance = {
        baseAsset: 0,
        quoteAsset: report.tradingDetail.finalBalance,
      };
    }
  }

  const details = reports.map((report) => report.tradingDetail!);
  const tradingDetail: TradingDetail = {
    baseAssetSymbol: symbol,
    action: "BUY",
    finalBalance: details.at(-1)?.finalBalance ?? params.balanceOverride?.quoteAsset ?? 0,
    usdtSpent: details.reduce((sum, detail) => sum + detail.usdtSpent, 0),
    totalFee: details.reduce((sum, detail) => sum + detail.totalFee, 0),
    totalTax: details.reduce((sum, detail) => sum + detail.totalTax, 0),
    totalProfit: 0,
    totalProfitPercent: 0,
  };
  const message = `[ENTRY_BOTH_DIRECTION] Opened MAIN ${legs[0].direction} and COUNTER ${legs[1].direction} for ${symbol}`;
  if (params.notificationTarget) {
    void notif.central({
      dashboard: params.notificationTarget.dashboard,
      // PROD:NOTIF_ENTRY
      key: params.notificationTarget.successKey,
      title: message,
      message: JSON.stringify({ reports }, null, 2),
    });
  }
  return {
    symbol,
    message,
    tradingDetail,
    tradingResult: reports.map((report) => report.tradingResult),
  };
}

export interface ExecutePairLegEntryProps extends Omit<
  ExecuteEntryProps,
  "internalLeg"
> {
  direction: Position["direction"];
  pairId: string;
  role: PositionRole;
}

/** Opens one missing role inside an existing streak-break worker pair. */
export async function executePairLegEntry(
  params: ExecutePairLegEntryProps,
): Promise<TradingReturn> {
  const symbol = params.entrySignal.symbol ?? "";
  const validationError = await validateBothDirectionEntry(params);
  if (validationError) {
    return { symbol, message: validationError };
  }

  return executeEntry({
    ...params,
    dynamicTradeConfig: {
      ...params.dynamicTradeConfig,
      openDirection: "BOTH",
    },
    internalLeg: {
      direction: params.direction,
      fundingWorkerLegs: 1,
      pairId: params.pairId,
      replenishPair: true,
      role: params.role,
    },
  });
}
