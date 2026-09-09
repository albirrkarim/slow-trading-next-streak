import type { EntryRecommendation } from "@/lib/brain/algorithms/type-execute";
import { decisionEngineLevelConfig } from "@/lib/brain/algorithms/v4/decisions/utils";
import type { VolatilityPoint } from "@/lib/dynamic";

const entrySequenceCandidates = {
  threshold: {
    /**
     * Resolves the dashboard threshold with the same rules as decision v19.
     */
    resolve(value?: number) {
      return decisionEngineLevelConfig.resolveMinAbsLevelToEntry(value);
    },
    resolveMax(value?: number) {
      return decisionEngineLevelConfig.resolveMaxAbsLevelToEntry(value);
    },
  },

  /**
   * Builds client-side entry candidates from loaded vPoints for dashboard-only
   * metric estimates. This avoids replaying the full decision engine on the API
   * path when the metric panels are collapsed.
   */
  build({
    maxAbsLevelToEntry,
    minAbsLevelToEntry,
    volatilityMap,
  }: {
    maxAbsLevelToEntry?: number;
    minAbsLevelToEntry?: number;
    volatilityMap: Record<string, VolatilityPoint[]>;
  }): EntryRecommendation[] {
    const threshold = entrySequenceCandidates.threshold.resolve(
      minAbsLevelToEntry,
    );
    const maximum = entrySequenceCandidates.threshold.resolveMax(
      maxAbsLevelToEntry,
    );

    return Object.entries(volatilityMap).flatMap(([rawSymbol, points]) => {
      const symbol = rawSymbol.trim().toUpperCase();
      if (symbol === "BTC") return [];

      return points
        .filter((point) =>
          decisionEngineLevelConfig.isEntryLevel(
            point,
            threshold,
            maximum,
          ),
        )
        .map((point) => ({
          ...point,
          amountProbab: 1,
          maxLeverage: 1,
          message: "client vPoint entry candidate",
          symbol,
        }));
    });
  },
};

export default entrySequenceCandidates;
