import type { VolatilityPoint } from "@/lib/dynamic";
import type {
  Position,
  PositionPendingReentry,
  PositionDirection,
  PositionRole,
  TradingModelMemory,
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

function fromClosedPosition(
  position: Position,
): PositionPendingReentry | undefined {
  if (!position.closed || !position.pairId) return undefined;

  return {
    pairId: position.pairId,
    role: bothDirection.position.role.resolve(position),
    direction: position.direction,
    opened: {
      t: position.opened.t,
      vPoint: position.opened.vPoint,
    },
    closeReason: position.closed.reason,
  };
}

function clearPending(params: {
  memory: TradingModelMemory;
  pairId: string;
  role?: PositionRole;
}) {
  params.memory.pendingReentries = (
    params.memory.pendingReentries ?? []
  ).filter(
    (pending) =>
      pending.pairId !== params.pairId ||
      (params.role !== undefined && pending.role !== params.role),
  );
  if (params.memory.pendingReentries.length === 0) {
    delete params.memory.pendingReentries;
  }
}

function recordClosed(params: {
  memory: TradingModelMemory;
  position: Position;
}) {
  const pending = fromClosedPosition(params.position);
  if (!pending) return;

  clearPending({
    memory: params.memory,
    pairId: pending.pairId,
    role: pending.role,
  });
  params.memory.pendingReentries = [
    ...(params.memory.pendingReentries ?? []),
    pending,
  ];
}

/** Updates pending re-entry state after a closed leg has been detached. */
function reconcileClosed(params: {
  memory: TradingModelMemory;
  position: Position;
}) {
  const pairId = bothDirection.pair.resolveId(params.position);
  const role = bothDirection.position.role.resolve(params.position);
  const hasSurvivor = (params.memory.positions ?? []).some(
    (candidate) =>
      !candidate.closed &&
      bothDirection.pair.resolveId(candidate) === pairId &&
      bothDirection.position.role.resolve(candidate) !== role,
  );

  if (hasSurvivor) {
    params.position.pairId = pairId;
    recordClosed(params);
    return;
  }
  clearPending({ memory: params.memory, pairId });
}

/** Migrates retained legacy closed legs and removes invalid pending state. */
function normalizeMemory(memory: TradingModelMemory) {
  const positions = memory.positions ?? [];
  const active = positions.filter((position) => !position.closed);
  memory.positions = active;

  for (const closed of positions.filter((position) => position.closed)) {
    if (!closed.pairId) continue;
    const role = bothDirection.position.role.resolve(closed);
    const hasSurvivor = active.some(
      (candidate) =>
        bothDirection.pair.resolveId(candidate) === closed.pairId &&
        bothDirection.position.role.resolve(candidate) !== role,
    );
    if (hasSurvivor) {
      closed.pairId = bothDirection.pair.resolveId(closed);
      recordClosed({ memory, position: closed });
    }
  }

  memory.pendingReentries = (memory.pendingReentries ?? []).filter(
    (pending) =>
      !active.some(
        (candidate) =>
          bothDirection.pair.resolveId(candidate) === pending.pairId &&
          bothDirection.position.role.resolve(candidate) === pending.role,
      ) &&
      active.some(
        (candidate) =>
          bothDirection.pair.resolveId(candidate) === pending.pairId &&
          bothDirection.position.role.resolve(candidate) !== pending.role,
      ),
  );
  if (memory.pendingReentries.length === 0) {
    delete memory.pendingReentries;
  }
}

/** Resolves whether one missing role may re-enter from the latest vPoint. */
function resolveReentry(params: {
  positions: Position[];
  pendingReentries?: PositionPendingReentry[];
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
  const pending = params.pendingReentries?.find(
    (candidate) => candidate.pairId === pairId && candidate.role === role,
  );

  if (!pending) {
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
    position: pending,
    volatilityPoints: params.volatilityPoints,
  });
  if (
    pending.closeReason !== "VOLATILITY_TARGET_EXIT" &&
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
  pending: {
    clear: clearPending,
    normalizeMemory,
    reconcileClosed,
    recordClosed,
  },
  reentry: {
    resolve: resolveReentry,
  },
  usage: {
    isPointUsedByRole,
  },
} as const;

export default streakBreak;
