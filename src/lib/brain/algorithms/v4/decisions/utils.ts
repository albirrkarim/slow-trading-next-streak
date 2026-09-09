import type { GrowthOvertimeDetail } from "@/lib/dynamic/backtest-volatility/type";
import type { DynamicTradeMemory } from "@/lib/dynamic";
import { MINIMAL_USDT_TO_TRADE } from "@/lib/trading/constants";

interface GetInvestmentAmountProps {
  allocationPercent: number;
  currentBalance: GrowthOvertimeDetail;
  dynamicTradeMemory: DynamicTradeMemory;
  recommendedPositionsLength: number;
}

/** Calculates the quote amount available to each recommended position. */
function getInvestmentAmount({
  allocationPercent,
  currentBalance,
  dynamicTradeMemory,
  recommendedPositionsLength,
}: GetInvestmentAmountProps): number {
  const commonSpent = currentBalance.currentBaseAssetLabeled.common;
  let quoteAssetToTrade = currentBalance.currentAsset - commonSpent;

  if (quoteAssetToTrade <= MINIMAL_USDT_TO_TRADE) {
    quoteAssetToTrade = 0;
  }

  quoteAssetToTrade = Math.min(
    dynamicTradeMemory.quoteAsset,
    Math.max(
      dynamicTradeMemory.startingBalanceUSDT * allocationPercent,
      quoteAssetToTrade * allocationPercent,
    ),
  );

  if (quoteAssetToTrade > 0 && recommendedPositionsLength > 0) {
    quoteAssetToTrade /= recommendedPositionsLength;
  }

  return quoteAssetToTrade;
}

/** Maps a number proportionally from one numeric range into another. */
function mapScaleValue(
  scale1Min: number,
  scale1Max: number,
  scale1CurrentValue: number,
  scale2Min: number,
  scale2Max: number,
): number {
  if (scale1Max === scale1Min) return scale2Min;

  const ratio = (scale1CurrentValue - scale1Min) / (scale1Max - scale1Min);
  return scale2Min + ratio * (scale2Max - scale2Min);
}

const DEFAULT_MIN_ABS_LEVEL_TO_ENTRY = 2;
const DEFAULT_MAX_ABS_LEVEL_TO_ENTRY = 5;
const MIN_ABS_LEVEL_TO_ENTRY = 0;

export const decisionEngineLevelConfig = {
  defaultMinAbsLevelToEntry: DEFAULT_MIN_ABS_LEVEL_TO_ENTRY,
  defaultMaxAbsLevelToEntry: DEFAULT_MAX_ABS_LEVEL_TO_ENTRY,

  /** Normalizes the configured absolute immediate-entry threshold. */
  resolveMinAbsLevelToEntry(value?: number) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return DEFAULT_MIN_ABS_LEVEL_TO_ENTRY;
    }
    return Math.max(MIN_ABS_LEVEL_TO_ENTRY, Math.floor(value));
  },

  /** Normalizes the inclusive maximum absolute entry level. */
  resolveMaxAbsLevelToEntry(value?: number) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return DEFAULT_MAX_ABS_LEVEL_TO_ENTRY;
    }
    return Math.max(MIN_ABS_LEVEL_TO_ENTRY, Math.floor(value));
  },

  /** Checks a vPoint against the configured inclusive absolute entry range. */
  isEntryLevel(
    point: { lvl?: number },
    minAbsLevelToEntry?: number,
    maxAbsLevelToEntry?: number,
  ) {
    const absoluteLevel = Math.abs(point.lvl ?? Number.NaN);
    return (
      typeof point.lvl === "number" &&
      Number.isFinite(point.lvl) &&
      absoluteLevel >=
        decisionEngineLevelConfig.resolveMinAbsLevelToEntry(
          minAbsLevelToEntry,
        ) &&
      absoluteLevel <=
        decisionEngineLevelConfig.resolveMaxAbsLevelToEntry(
          maxAbsLevelToEntry,
        )
    );
  },
};

const decisionEngineUtils = {
  investment: {
    getAmount: getInvestmentAmount,
  },
  number: {
    mapScale: mapScaleValue,
  },
  level: decisionEngineLevelConfig,
} as const;

export default decisionEngineUtils;
export { getInvestmentAmount, mapScaleValue };
