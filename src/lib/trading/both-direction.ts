import type { OpenDirection, VolatilityPoint } from "@/lib/dynamic";
import type {
  Position,
  PositionDirection,
  PositionRole,
} from "@/lib/trading/models";

type VolatilityTargetPosition = {
  opened: {
    t: Position["opened"]["t"];
    vPoint: Pick<Position["opened"]["vPoint"], "lvl">;
  };
};

function normalizeOpenDirection(value: unknown): OpenDirection {
  return value === "BOTH" ? "BOTH" : "ONE_WAY";
}

function isEnabled(value: unknown): boolean {
  return normalizeOpenDirection(value) === "BOTH";
}

function resolveRole(position: Pick<Position, "role">): PositionRole {
  return position.role === "COUNTER" ? "COUNTER" : "MAIN";
}

function matchesPair(
  left: Pick<Position, "opened" | "symbol">,
  right: Pick<Position, "opened" | "symbol">,
): boolean {
  return (
    String(left.symbol || "").toUpperCase() ===
      String(right.symbol || "").toUpperCase() &&
    left.opened.vPoint.id === right.opened.vPoint.id &&
    left.opened.t === right.opened.t
  );
}

function hasCounterpart(position: Position, positions: Position[]): boolean {
  return positions.some(
    (candidate) =>
      candidate !== position &&
      matchesPair(position, candidate) &&
      resolveRole(candidate) !== resolveRole(position),
  );
}

function oppositeDirection(direction: PositionDirection): PositionDirection {
  return direction === "LONG" ? "SHORT" : "LONG";
}

function resolveEntryLegs(params: {
  mainDirection: PositionDirection;
  openDirection?: OpenDirection;
}): Array<{ direction: PositionDirection; role: PositionRole }> {
  const main = { direction: params.mainDirection, role: "MAIN" as const };
  return isEnabled(params.openDirection)
    ? [
        main,
        {
          direction: oppositeDirection(params.mainDirection),
          role: "COUNTER" as const,
        },
      ]
    : [main];
}

function getPostEntryPoints<TPoint extends Pick<VolatilityPoint, "t">>(
  position: VolatilityTargetPosition,
  volatilityPoints: TPoint[],
): TPoint[] {
  return volatilityPoints
    .filter(
      (point) =>
        Number.isFinite(point.t) && point.t > position.opened.t,
    )
    .sort((left, right) => left.t - right.t);
}

export interface VolatilityTargetState<TPoint> {
  armedPoint?: TPoint;
  targetPoint?: TPoint;
  hasReached: boolean;
  isCurrent: boolean;
}

/**
 * Resolves the shared volatility target. A non-zero entry level arms it
 * immediately; otherwise, the first later non-zero level arms it. The next
 * post-entry level zero is the target regardless of TOP/BOTTOM direction.
 */
function resolveVolatilityTarget<
  TPoint extends Pick<VolatilityPoint, "id" | "lvl" | "t">,
>(params: {
  position: VolatilityTargetPosition;
  volatilityPoints: TPoint[];
}): VolatilityTargetState<TPoint> {
  const postEntryPoints = getPostEntryPoints(
    params.position,
    params.volatilityPoints,
  ).filter((point) => Number.isFinite(point.lvl));
  let isArmed =
    Number.isFinite(params.position.opened.vPoint.lvl) &&
    params.position.opened.vPoint.lvl !== 0;
  let armedPoint: TPoint | undefined;
  let targetPoint: TPoint | undefined;

  for (const point of postEntryPoints) {
    if (point.lvl !== 0) {
      if (!isArmed) {
        isArmed = true;
        armedPoint = point;
      }
      continue;
    }
    if (isArmed) {
      targetPoint = point;
      break;
    }
  }

  const currentPoint = postEntryPoints.at(-1);
  return {
    armedPoint,
    targetPoint,
    hasReached: Boolean(targetPoint),
    isCurrent: Boolean(
      targetPoint && currentPoint && targetPoint.id === currentPoint.id,
    ),
  };
}

/** Checks whether a leg passed at least one whole level in its profit direction. */
function hasPassedProfitLevel(params: {
  position: Pick<Position, "direction" | "opened">;
  volatilityPoints: VolatilityPoint[];
}): boolean {
  const entryLevel = params.position.opened.vPoint.lvl;
  return getPostEntryPoints(params.position, params.volatilityPoints).some(
    (point) =>
      (params.position.direction === "LONG" &&
        point.lvl >= entryLevel + 1) ||
      (params.position.direction === "SHORT" &&
        point.lvl <= entryLevel - 1),
  );
}

function mayUseCounterProfitProtection(params: {
  position: Position;
  positions: Position[];
  volatilityPoints: VolatilityPoint[];
}): boolean {
  if (resolveRole(params.position) === "MAIN") {
    return true;
  }
  const main = params.positions.find(
    (position) =>
      resolveRole(position) === "MAIN" &&
      matchesPair(params.position, position),
  );
  return Boolean(
    main?.closed &&
      hasPassedProfitLevel({
        position: params.position,
        volatilityPoints: params.volatilityPoints,
      }),
  );
}

function countOpenPairs(positions: Position[]): number {
  const identities = new Set<string>();
  for (const position of positions) {
    if (position.closed) continue;
    identities.add(
      `${String(position.symbol || "").toUpperCase()}:${position.opened.vPoint.id}:${position.opened.t}`,
    );
  }
  return identities.size;
}

const bothDirection = {
  config: {
    isEnabled,
    normalize: normalizeOpenDirection,
  },
  direction: {
    opposite: oppositeDirection,
  },
  entry: {
    resolveLegs: resolveEntryLegs,
  },
  pair: {
    countOpen: countOpenPairs,
    hasCounterpart,
    matches: matchesPair,
  },
  position: {
    role: {
      resolve: resolveRole,
    },
  },
  profitProtection: {
    counterAllowed: mayUseCounterProfitProtection,
    hasPassedProfitLevel,
  },
  volatilityTarget: {
    resolve: resolveVolatilityTarget,
  },
} as const;

export default bothDirection;
