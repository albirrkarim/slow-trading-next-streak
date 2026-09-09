import type { EntryLegs, OpenDirection, VolatilityPoint } from "@/lib/dynamic";
import { VOLATILITY_THRESHOLD } from "@/lib/brain/constants";
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

function normalizeEntryLegs(value: unknown): EntryLegs {
  if (value === "MAIN" || value === "COUNTER") return value;
  return "BOTH";
}

function resolveRole(position: Pick<Position, "role">): PositionRole {
  return position.role === "COUNTER" ? "COUNTER" : "MAIN";
}

function isHedgeStrategyPosition(
  position: Pick<Position, "entryLegs">,
): boolean {
  return (
    position.entryLegs === "MAIN" ||
    position.entryLegs === "COUNTER" ||
    position.entryLegs === "BOTH"
  );
}

/** Builds the stable identity shared by every generation of a worker pair. */
function buildPairId(position: {
  opened: {
    t: Position["opened"]["t"];
    vPoint: Pick<Position["opened"]["vPoint"], "id">;
  };
  symbol: string;
}): string {
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
      isHedgeStrategyPosition(position) ||
      resolveRole(position) === "COUNTER" ||
      hasCounterpart(position, positions),
  );
}

function oppositeDirection(direction: PositionDirection): PositionDirection {
  return direction === "LONG" ? "SHORT" : "LONG";
}

function resolveEntryLegs(params: {
  entryLegs?: EntryLegs;
  mainDirection: PositionDirection;
  openDirection?: OpenDirection;
}): Array<{ direction: PositionDirection; role: PositionRole }> {
  // BOTH:ACCOUNT_ENTRY_LEGS
  const main = { direction: params.mainDirection, role: "MAIN" as const };
  if (!isEnabled(params.openDirection)) return [main];

  const counter = {
    direction: oppositeDirection(params.mainDirection),
    role: "COUNTER" as const,
  };
  const entryLegs = normalizeEntryLegs(params.entryLegs);
  if (entryLegs === "MAIN") return [main];
  if (entryLegs === "COUNTER") return [counter];
  return [main, counter];
}

/** Resolves the position roles consumed by one fresh entry selection. */
function resolveEntryRoles(params: {
  entryLegs?: EntryLegs;
  openDirection?: OpenDirection;
}): PositionRole[] | undefined {
  if (!isEnabled(params.openDirection)) return undefined;
  return resolveEntryLegs({
    entryLegs: params.entryLegs,
    mainDirection: "LONG",
    openDirection: params.openDirection,
  }).map((leg) => leg.role);
}

/** Counts the legs funded and opened by one new logical worker. */
function countEntryLegs(params: {
  entryLegs?: EntryLegs;
  openDirection?: OpenDirection;
}): number {
  if (!isEnabled(params.openDirection)) return 1;
  return normalizeEntryLegs(params.entryLegs) === "BOTH" ? 2 : 1;
}

function getPostEntryPoints<TPoint extends Pick<VolatilityPoint, "t">>(
  position: VolatilityTargetPosition,
  volatilityPoints: TPoint[],
): TPoint[] {
  const anchorTime = position.opened.vPoint.t ?? position.opened.t;
  return volatilityPoints
    .filter((point) => Number.isFinite(point.t) && point.t > anchorTime)
    .sort((left, right) => left.t - right.t);
}

export interface VolatilityTargetState<TPoint> {
  armedPoint?: TPoint;
  targetPoint?: TPoint;
  hasReached: boolean;
  isCurrent: boolean;
}

/** Resolves the first level-zero target after a position becomes armed. */
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
  const targetPoint = postEntryPoints.find((point) => point.l === targetLabel);
  const currentPoint = postEntryPoints.at(-1);

  return {
    targetPoint,
    hasReached: Boolean(targetPoint),
    isCurrent: Boolean(
      targetPoint && currentPoint && targetPoint.id === currentPoint.id,
    ),
  };
}

export interface ProfitProtectionState {
  allowed: boolean;
  exceptionTriggered: boolean;
  favorableDistancePct: number;
}

/** Resolves the forming-vPoint distance exception for traditional TP and SL+. */
function evaluateProfitProtection(params: {
  currentPrice: number;
  latestVolatilityPrice?: number;
  position: Position;
  positions: Position[];
  volatilityThreshold?: number;
}): ProfitProtectionState {
  const isBothPosition =
    isHedgeStrategyPosition(params.position) ||
    isPairLeg(params.position, params.positions);
  if (!isBothPosition) {
    return {
      allowed: true,
      exceptionTriggered: false,
      favorableDistancePct: 0,
    };
  }

  const currentPrice = Number(params.currentPrice);
  const anchorPrice = Number(params.latestVolatilityPrice);
  const volatilityThreshold = Number(
    params.volatilityThreshold ?? VOLATILITY_THRESHOLD,
  );
  if (
    !Number.isFinite(currentPrice) ||
    currentPrice <= 0 ||
    !Number.isFinite(anchorPrice) ||
    anchorPrice <= 0 ||
    !Number.isFinite(volatilityThreshold) ||
    volatilityThreshold < 0
  ) {
    return {
      allowed: false,
      exceptionTriggered: false,
      favorableDistancePct: 0,
    };
  }

  const favorableDistancePct =
    params.position.direction === "SHORT"
      ? ((anchorPrice - currentPrice) / anchorPrice) * 100
      : ((currentPrice - anchorPrice) / anchorPrice) * 100;
  const exceptionTriggered = favorableDistancePct >= volatilityThreshold;

  return {
    allowed: exceptionTriggered,
    exceptionTriggered,
    favorableDistancePct,
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
    count: countEntryLegs,
    normalizeSelection: normalizeEntryLegs,
    pairId: {
      build: buildPairId,
    },
    resolveLegs: resolveEntryLegs,
    resolveRoles: resolveEntryRoles,
  },
  pair: {
    countOpen: countOpenPairs,
    hasCounterpart,
    isLeg: isPairLeg,
    matches: matchesPair,
    resolveId: resolvePairId,
  },
  position: {
    isHedgeStrategy: isHedgeStrategyPosition,
    role: {
      resolve: resolveRole,
    },
  },
  profitProtection: {
    evaluate: evaluateProfitProtection,
  },
  volatilityTarget: {
    resolve: resolveLevelZeroVolatilityTarget,
    directional: {
      resolve: resolveDirectionalVolatilityTarget,
    },
    levelZero: {
      resolve: resolveLevelZeroVolatilityTarget,
    },
  },
} as const;

export default bothDirection;
