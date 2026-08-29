import type { VolatilityPoint } from "@/lib/dynamic";
import type {
  Position,
  PositionDirection,
  PositionRole,
} from "@/lib/trading/models";
import bothDirection from "./both-direction";

export interface StreakBreakReentryDecision {
  direction: PositionDirection;
  pairId: string;
  point?: VolatilityPoint;
  reason: string;
  role: PositionRole;
  status: "READY" | "WAITING";
  survivor: Position;
}

function isPointUsedByRole(
  point: VolatilityPoint,
  role: PositionRole,
): boolean {
  if (point.used === true) {
    return true;
  }

  return role === "COUNTER"
    ? point.usedByCounter === true
    : point.usedByMain === true;
}

function getLatestClosedRole(params: {
  pairId: string;
  positions: Position[];
  role: PositionRole;
}): Position | undefined {
  return params.positions
    .filter(
      (position) =>
        position.closed &&
        bothDirection.pair.resolveId(position) === params.pairId &&
        bothDirection.position.role.resolve(position) === params.role,
    )
    .sort((left, right) => (right.closed?.t ?? 0) - (left.closed?.t ?? 0))[0];
}

/** Resolves whether one missing role may re-enter from the latest vPoint. */
function resolveReentry(params: {
  positions: Position[];
  volatilityPoints: VolatilityPoint[];
}): StreakBreakReentryDecision | undefined {
  const active = params.positions.filter((position) => !position.closed);
  if (active.length !== 1) {
    return undefined;
  }

  const survivor = active[0];
  if (!bothDirection.pair.isLeg(survivor, params.positions)) {
    return undefined;
  }

  const pairId = bothDirection.pair.resolveId(survivor);
  const survivorRole = bothDirection.position.role.resolve(survivor);
  const role: PositionRole =
    survivorRole === "MAIN" ? "COUNTER" : "MAIN";
  const direction = bothDirection.direction.opposite(survivor.direction);
  const closedRole = getLatestClosedRole({
    pairId,
    positions: params.positions,
    role,
  });

  if (!closedRole) {
    return {
      direction,
      pairId,
      reason: `Waiting for closed ${role} lifecycle state`,
      role,
      status: "WAITING",
      survivor,
    };
  }

  const target = bothDirection.volatilityTarget.directional.resolve({
    position: closedRole,
    volatilityPoints: params.volatilityPoints,
  });
  if (
    closedRole.closed?.reason !== "VOLATILITY_TARGET_EXIT" &&
    !target.hasReached
  ) {
    return {
      direction,
      pairId,
      reason:
        `Waiting for the next confirmed ${direction === "LONG" ? "TOP" : "BOTTOM"} ` +
        `before reopening ${role} ${direction}`,
      role,
      status: "WAITING",
      survivor,
    };
  }

  const orderedPoints = [...params.volatilityPoints]
    .filter((candidate) => Number.isFinite(candidate.t))
    .sort((left, right) => left.t - right.t);
  const point = orderedPoints
    .filter(
      (candidate) =>
        (!target.targetPoint || candidate.t >= target.targetPoint.t) &&
        !isPointUsedByRole(candidate, role),
    )
    .at(-1);
  if (!point) {
    const latestPoint = orderedPoints.at(-1);
    return {
      direction,
      pairId,
      reason: latestPoint
        ? `Latest vPoint ${latestPoint.id} was already used for ${role} entry`
        : `Waiting for a confirmed vPoint to reopen ${role} ${direction}`,
      role,
      status: "WAITING",
      survivor,
    };
  }

  return {
    direction,
    pairId,
    point,
    reason: `Reopen ${role} ${direction} from ${point.id}`,
    role,
    status: "READY",
    survivor,
  };
}

const streakBreak = {
  reentry: {
    resolve: resolveReentry,
  },
  usage: {
    isPointUsedByRole,
  },
} as const;

export default streakBreak;
