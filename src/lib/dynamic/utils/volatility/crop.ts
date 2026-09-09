import type { VolatilityPoint } from "./volatility";

/** Selects the visible trailing volatility points for one simulation time. */
export function cropVolatility(
  currentTimeMs: number,
  volatilityMap: Record<string, VolatilityPoint[]>,
  startTimeMs?: number,
  includeCurrentPoint = false,
): Record<string, VolatilityPoint[]> {
  const croppedMap: Record<string, VolatilityPoint[]> = {};

  for (const symbol of Object.keys(volatilityMap)) {
    const visiblePoints = volatilityMap[symbol].filter((point) =>
      includeCurrentPoint
        ? point.t <= currentTimeMs
        : point.t < currentTimeMs,
    );
    croppedMap[symbol] = (
      startTimeMs
        ? visiblePoints.filter((point) => point.t >= startTimeMs)
        : visiblePoints
    ).slice(-100);
  }

  return croppedMap;
}
