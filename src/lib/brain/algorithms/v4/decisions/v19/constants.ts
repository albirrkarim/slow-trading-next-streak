const HOUR_MS = 60 * 60 * 1_000;
const DEFAULT_MIN_ABS_LEVEL_TO_ENTRY = 2;
const DEFAULT_MAX_ABS_LEVEL_TO_ENTRY = 5;
const MIN_ABS_LEVEL_TO_ENTRY = 0;

export const DECISION_V19_HOUR_MS = HOUR_MS;
export const DECISION_V19_LATEST_KLINE_CONCURRENCY = 8;

export const decisionEngineLevelConfig = {
  defaultMinAbsLevelToEntry: DEFAULT_MIN_ABS_LEVEL_TO_ENTRY,
  defaultMaxAbsLevelToEntry: DEFAULT_MAX_ABS_LEVEL_TO_ENTRY,

  /**
   * Normalizes the configured absolute immediate-entry threshold.
   */
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

  /**
   * Checks a vPoint against the configured inclusive absolute entry range.
   */
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

export const DECISION_V19_SPEED_TIER_CONFIG = {
  1: {
    avgHoldMs: 24 * HOUR_MS,
    maxHoldMs: 96 * HOUR_MS,
    transitionMaxMs: 30 * HOUR_MS,
  },
  2: {
    avgHoldMs: 48 * HOUR_MS,
    maxHoldMs: 168 * HOUR_MS,
    transitionMaxMs: 30 * HOUR_MS,
  },
  3: {
    avgHoldMs: 72 * HOUR_MS,
    maxHoldMs: 336 * HOUR_MS,
    transitionMaxMs: 48 * HOUR_MS,
  },
} as const;

export type SpeedTier = keyof typeof DECISION_V19_SPEED_TIER_CONFIG;
