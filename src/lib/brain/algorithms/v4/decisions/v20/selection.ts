import type {
  EntryRecommendation,
  EntryRecommendationEvaluation,
} from "@lib/brain/algorithms/type-execute";
import type { VolatilityPoint } from "@lib/dynamic/utils/volatility";

import { decisionEngineLevelConfig, mapScaleValue } from "../utils";

function makeEntryRecommendation(
  point: VolatilityPoint,
  minAbsLevelToEntry: number,
  maxAbsLevelToEntry: number,
): EntryRecommendation {
  let amountProbab = 0;

  if (point.l === "B") {
    amountProbab = mapScaleValue(
      -1,
      -5,
      point.lvl,
      0.5,
      point.probability ?? 1,
    );
  }

  if (point.l === "T") {
    amountProbab = mapScaleValue(
      1,
      5,
      point.lvl,
      0.5,
      point.probability ?? 1,
    );
  }

  const direction = point.l === "B" ? "LONG" : "SHORT";

  return {
    ...point,
    amountProbab,
    maxLeverage: 3,
    message:
      `decision.v20 ${direction}: absolute level ${Math.abs(point.lvl)} ` +
      `is within entry range ${minAbsLevelToEntry}-${maxAbsLevelToEntry}`,
  };
}

/** Evaluates direct level-based v20 entry recommendations. */
export function evaluateRecommendationsV20Sync({
  minAbsLevelToEntry,
  maxAbsLevelToEntry,
  volatilityPointsMap,
}: {
  minAbsLevelToEntry?: number;
  maxAbsLevelToEntry?: number;
  volatilityPointsMap: Record<string, VolatilityPoint[]>;
}): EntryRecommendationEvaluation {
  const diagnostics: EntryRecommendationEvaluation["diagnostics"] = [];
  const recommendations: EntryRecommendation[] = [];
  const resolvedMinAbsLevelToEntry =
    decisionEngineLevelConfig.resolveMinAbsLevelToEntry(
      minAbsLevelToEntry,
    );
  const resolvedMaxAbsLevelToEntry =
    decisionEngineLevelConfig.resolveMaxAbsLevelToEntry(
      maxAbsLevelToEntry,
    );

  for (const [symbol, points] of Object.entries(volatilityPointsMap)) {
    const currentPoint = points.at(-1);
    if (
      !currentPoint ||
      !decisionEngineLevelConfig.isEntryLevel(
        currentPoint,
        resolvedMinAbsLevelToEntry,
        resolvedMaxAbsLevelToEntry,
      )
    ) {
      continue;
    }

    currentPoint.symbol = symbol;

    if (symbol === "BTC") {
      diagnostics.push({
        code: "BTC_CONTEXT_ONLY",
        level: currentPoint.lvl,
        pointId: currentPoint.id,
        reason:
          "Blocked because BTC is market context and is not an entry candidate.",
        status: "blocked",
        symbol,
      });
      continue;
    }

    if (currentPoint.used) {
      diagnostics.push({
        code: "USED_VOLATILITY_POINT",
        level: currentPoint.lvl,
        pointId: currentPoint.id,
        reason: "Blocked because this volatility point was already used.",
        status: "blocked",
        symbol,
      });
      continue;
    }

    // BOTH:DECISION_V20_LEVEL_GATE
    // v20 enters every unused latest point at or above the configured level.
    // It does not project lower levels or rank candidates by Speed timing.
    currentPoint.used = true;
    recommendations.push(
      makeEntryRecommendation(
        currentPoint,
        resolvedMinAbsLevelToEntry,
        resolvedMaxAbsLevelToEntry,
      ),
    );
    diagnostics.push({
      code: "READY",
      level: currentPoint.lvl,
      pointId: currentPoint.id,
      reason:
        `Ready: decision.v20 accepts absolute level ${Math.abs(currentPoint.lvl)} ` +
        `inside configured entry range ${resolvedMinAbsLevelToEntry}-${resolvedMaxAbsLevelToEntry}.`,
      status: "ready",
      symbol,
    });
  }

  return {
    diagnostics,
    recommendations,
  };
}

/** Gets direct level-based v20 recommendations without timing estimation. */
export function getRecommendationsV20Sync(
  params: Parameters<typeof evaluateRecommendationsV20Sync>[0],
): EntryRecommendation[] {
  return evaluateRecommendationsV20Sync(params).recommendations;
}
