import type { OpenDirection, VolatilityPoint } from "@/lib/dynamic";
import type {
  Position,
  PositionDirection,
  PositionRole,
} from "@/lib/trading/models";

type VolatilityTargetPosition = {
  direction: PositionDirection;
  opened: {
    t: Position["opened"]["t"];
    vPoint: Pick<Position["opened"]["vPoint"], "lvl" | "t">;
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

/** Builds the stable identity shared by every generation of a worker pair. */
function buildPairId(
  position: {
    opened: {
      t: Position["opened"]["t"];
      vPoint: Pick<Position["opened"]["vPoint"], "id">;
    };
    symbol: string;
  },
): string {
  return [
    String(position.symbol || "").toUpperCase(),
    position.opened.vPoint.id,
    position.opened.t,
  ].join(":");
}

function resolvePairId(
  position: Pick<Position, "opened" | "pairId" | "symbol">,
): string {
  return position.pairId || buildPairId(position);
}

function matchesPair(
  left: Pick<Position, "opened" | "pairId" | "symbol">,
  right: Pick<Position, "opened" | "pairId" | "symbol">,
): boolean {
  return (
    String(left.symbol || "").toUpperCase() ===
      String(right.symbol || "").toUpperCase() &&
    resolvePairId(left) === resolvePairId(right)
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

function isPairLeg(position: Position, positions: Position[]): boolean {
  return Boolean(
    position.pairId ||
      resolveRole(position) === "COUNTER" ||
      hasCounterpart(position, positions),
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
  const anchorTime = position.opened.vPoint.t ?? position.opened.t;
  return volatilityPoints
    .filter(
      (point) =>
        Number.isFinite(point.t) && point.t > anchorTime,
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
function resolveLevelZeroVolatilityTarget<
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

/** Resolves the first favorable confirmed rail after a leg's entry. */
function resolveDirectionalVolatilityTarget<
  TPoint extends Pick<VolatilityPoint, "id" | "l" | "lvl" | "t">,
>(params: {
  position: VolatilityTargetPosition;
  volatilityPoints: TPoint[];
}): VolatilityTargetState<TPoint> {
  const targetLabel = params.position.direction === "LONG" ? "T" : "B";
  const postEntryPoints = getPostEntryPoints(
    params.position,
    params.volatilityPoints,
  );
  const targetPoint = postEntryPoints.find(
    (point) => point.l === targetLabel,
  );
  const currentPoint = postEntryPoints.at(-1);

  return {
    targetPoint,
    hasReached: Boolean(targetPoint),
    isCurrent: Boolean(
      targetPoint && currentPoint && targetPoint.id === currentPoint.id,
    ),
  };
}

function countOpenPairs(positions: Position[]): number {
  const identities = new Set<string>();
  for (const position of positions) {
    if (position.closed) continue;
    identities.add(resolvePairId(position));
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
    pairId: {
      build: buildPairId,
    },
    resolveLegs: resolveEntryLegs,
  },
  pair: {
    countOpen: countOpenPairs,
    hasCounterpart,
    isLeg: isPairLeg,
    matches: matchesPair,
    resolveId: resolvePairId,
  },
  position: {
    role: {
      resolve: resolveRole,
    },
  },
  volatilityTarget: {
    directional: {
      resolve: resolveDirectionalVolatilityTarget,
    },
    levelZero: {
      resolve: resolveLevelZeroVolatilityTarget,
    },
  },
} as const;

export default bothDirection;
