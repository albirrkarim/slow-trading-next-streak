import { deepCopy } from "@/components/client/utils";
import { getRecommendationsProduction } from "@/lib/brain/algorithms";
import type { EntryRecommendation } from "@/lib/brain/algorithms/type-execute";
import { tradeLog } from "@/lib/trading";
import type { TradingModelMemory } from "@/lib/trading/models";
import moment from "moment-timezone";
import { cropVolatility } from "./volatility/crop";
import {
  resetVolatilityPointEntryUsage,
  type VolatilityPoint,
} from "./volatility";

interface GetHistoricalEntrySignalProps {
  volatilityMap: Record<string, VolatilityPoint[]>;
  getRecommendations?: typeof getRecommendationsProduction;
  minAbsLevelToEntry?: number;
  maxAbsLevelToEntry?: number;
}

/** Replays decision.v20 against each historical volatility-point timestamp. */
export async function getHistoricalEntrySignal({
  volatilityMap,
  getRecommendations = getRecommendationsProduction,
  minAbsLevelToEntry,
  maxAbsLevelToEntry,
}: GetHistoricalEntrySignalProps): Promise<EntryRecommendation[]> {
  const volatilityMapForHistory = deepCopy(volatilityMap);
  const symbols = Object.keys(volatilityMapForHistory);

  for (const symbol of symbols) {
    for (const point of volatilityMapForHistory[symbol] ?? []) {
      resetVolatilityPointEntryUsage(point);
    }
  }

  const modelMemoryMap: Record<string, TradingModelMemory> = Object.fromEntries(
    symbols.map((symbol) => [
      symbol,
      {
        positions: [],
        volatility: { symbol, lastVolatility: [] },
      },
    ]),
  );
  const times = [
    ...new Set(
      Object.values(volatilityMapForHistory)
        .flat()
        .map((item) => item.t),
    ),
  ].sort((a, b) => a - b);
  const entryRecommendations: EntryRecommendation[] = [];

  tradeLog.debug("RUN BACKTEST");
  tradeLog.debug("start ", moment(times[0]).format("DD-MMM-YYYY HH:mm"));
  tradeLog.debug(
    "end ",
    moment(times[times.length - 1]).format("DD-MMM-YYYY HH:mm"),
  );

  for (const currentTimeMs of times) {
    const visibleVolatility = cropVolatility(
      currentTimeMs,
      volatilityMapForHistory,
    );
    entryRecommendations.push(
      ...(await getRecommendations({
        volatilityPointsMap: visibleVolatility,
        modelMemoryMap,
        minAbsLevelToEntry,
        maxAbsLevelToEntry,
      })),
    );
  }

  tradeLog.debug("RUN BACKTEST END");
  return entryRecommendations;
}
