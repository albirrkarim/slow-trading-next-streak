import type {
  Position,
  PostAverageStopLossConfig,
  PostAverageStopLossThreshold,
} from "@/lib/trading/models";
import postAverageRescue from "./post-average-rescue";

const DEFAULT_THRESHOLDS: readonly PostAverageStopLossThreshold[] = [
  {
    maxNetPnlPct: 0,
    maxNetPnlUsdt: 0,
    maxVPointAdverseDriftPct: 0,
    minAveragingCount: 1,
  },
];

type AveragedPosition = Pick<Position, "direction" | "strategy">;

/** Creates a disabled, independently mutable default configuration. */
function createDefaultConfig(): PostAverageStopLossConfig {
  return {
    enabled: false,
    thresholds: DEFAULT_THRESHOLDS.map((threshold) => ({ ...threshold })),
  };
}

function normalizeLossBoundary(value: unknown): number {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? Math.min(0, numericValue) : 0;
}

function normalizeAdverseDriftBoundary(value: unknown): number {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? Math.max(0, numericValue) : 0;
}

/** Calculates adverse price drift from an averaging vPoint anchor. */
function calculateAdverseDriftPct({
  currentPrice,
  direction,
  vPointPrice,
}: {
  currentPrice: number;
  direction: Position["direction"];
  vPointPrice: number;
}): number | undefined {
  if (
    !Number.isFinite(currentPrice) ||
    currentPrice <= 0 ||
    !Number.isFinite(vPointPrice) ||
    vPointPrice <= 0
  ) {
    return undefined;
  }

  return direction === "SHORT"
    ? ((currentPrice - vPointPrice) / vPointPrice) * 100
    : ((vPointPrice - currentPrice) / vPointPrice) * 100;
}

/** Resolves the exact price at a positive adverse vPoint-drift boundary. */
function resolveAdverseDriftExitPrice({
  direction,
  maxVPointAdverseDriftPct,
  vPointPrice,
}: {
  direction: Position["direction"];
  maxVPointAdverseDriftPct: number;
  vPointPrice: number;
}): number | undefined {
  if (
    !Number.isFinite(vPointPrice) ||
    vPointPrice <= 0 ||
    !Number.isFinite(maxVPointAdverseDriftPct) ||
    maxVPointAdverseDriftPct <= 0
  ) {
    return undefined;
  }

  const driftRatio = maxVPointAdverseDriftPct / 100;
  return direction === "SHORT"
    ? vPointPrice * (1 + driftRatio)
    : vPointPrice * (1 - driftRatio);
}

/** Sanitizes persisted or user-edited post-average stop loss configuration. */
function normalizeConfig(
  config?: PostAverageStopLossConfig,
): PostAverageStopLossConfig {
  if (!config) return createDefaultConfig();

  const thresholds = new Map<number, PostAverageStopLossThreshold>();
  for (const threshold of Array.isArray(config.thresholds)
    ? config.thresholds
    : []) {
    const minAveragingCount = Math.max(
      1,
      Math.floor(Number(threshold.minAveragingCount)),
    );
    if (!Number.isFinite(minAveragingCount)) continue;

    thresholds.set(minAveragingCount, {
      maxNetPnlPct: normalizeLossBoundary(threshold.maxNetPnlPct),
      maxNetPnlUsdt: normalizeLossBoundary(threshold.maxNetPnlUsdt),
      maxVPointAdverseDriftPct: normalizeAdverseDriftBoundary(
        threshold.maxVPointAdverseDriftPct,
      ),
      minAveragingCount,
    });
  }

  return {
    enabled: config.enabled === true,
    thresholds: [...thresholds.values()].sort(
      (left, right) => left.minAveragingCount - right.minAveragingCount,
    ),
  };
}

/** Selects the greatest configured averaging tier already reached. */
function getThreshold(
  completedAveragingCount: number,
  config?: PostAverageStopLossConfig,
): PostAverageStopLossThreshold | undefined {
  const resolvedConfig = normalizeConfig(config);
  if (!resolvedConfig.enabled) return undefined;

  let selected: PostAverageStopLossThreshold | undefined;
  for (const threshold of resolvedConfig.thresholds) {
    if (threshold.minAveragingCount <= completedAveragingCount) {
      selected = threshold;
    }
  }
  return selected;
}

/** Evaluates independent fee-aware percent and USDT loss boundaries. */
function evaluate({
  config,
  currentPrice,
  netPnlPercent,
  netPnlUsdt,
  position,
}: {
  config?: PostAverageStopLossConfig;
  currentPrice?: number;
  netPnlPercent: number;
  netPnlUsdt: number;
  position?: AveragedPosition | null;
}) {
  // BOTH:POST_AVERAGE_STOP_LOSS
  const completedAveragingCount =
    postAverageRescue.averaging.countCompleted(position);
  const threshold = getThreshold(completedAveragingCount, config);
  const percentEnabled = (threshold?.maxNetPnlPct ?? 0) < 0;
  const usdtEnabled = (threshold?.maxNetPnlUsdt ?? 0) < 0;
  const vPointAdverseDriftEnabled =
    (threshold?.maxVPointAdverseDriftPct ?? 0) > 0;
  const latestAveragingExecution =
    position?.strategy.averaging.executions?.at(-1);
  const vPointAdverseDriftPct =
    currentPrice === undefined ||
    !position ||
    latestAveragingExecution?.vPointPrice === undefined
      ? undefined
      : calculateAdverseDriftPct({
          currentPrice,
          direction: position.direction,
          vPointPrice: latestAveragingExecution.vPointPrice,
        });
  const hitPercent =
    percentEnabled && netPnlPercent <= (threshold?.maxNetPnlPct ?? 0);
  const hitUsdt = usdtEnabled && netPnlUsdt <= (threshold?.maxNetPnlUsdt ?? 0);
  const hitVPointAdverseDrift =
    vPointAdverseDriftEnabled &&
    vPointAdverseDriftPct !== undefined &&
    vPointAdverseDriftPct >= (threshold?.maxVPointAdverseDriftPct ?? 0);

  return {
    completedAveragingCount,
    hitPercent,
    hitUsdt,
    hitVPointAdverseDrift,
    latestVPointPrice: latestAveragingExecution?.vPointPrice,
    shouldExit: hitPercent || hitUsdt || hitVPointAdverseDrift,
    threshold,
    vPointAdverseDriftPct,
  };
}

const postAverageStopLoss = {
  config: {
    createDefault: createDefaultConfig,
    normalize: normalizeConfig,
  },
  evaluate,
  drift: {
    calculatePct: calculateAdverseDriftPct,
    resolveExitPrice: resolveAdverseDriftExitPrice,
  },
  threshold: {
    get: getThreshold,
  },
} as const;

export default postAverageStopLoss;
