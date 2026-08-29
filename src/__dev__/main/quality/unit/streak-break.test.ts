import type { VolatilityPoint } from "@/lib/dynamic";
import streakBreak from "@/lib/trading/streak-break";
import bothDirection from "@/lib/trading/both-direction";
import type { TradingModelMemory } from "@/lib/trading/models";
import { createTestPosition } from "../fixtures/position";

function point(
  id: string,
  l: "T" | "B",
  lvl: number,
  t: number,
): VolatilityPoint {
  return { id, l, lvl, p: 100, pct: 2, t, vb: 1, vq: 1 };
}

describe("streak-break pair lifecycle", () => {
  it("uses direction rather than numeric level to resolve each leg target", () => {
    const long = createTestPosition({
      direction: "LONG",
      entryLevel: 3,
      entryTime: 1,
    });
    const short = createTestPosition({
      direction: "SHORT",
      entryLevel: -3,
      entryTime: 1,
    });
    const points = [
      point("BOTTOM[-4]", "B", -4, 2),
      point("TOP[5]", "T", 5, 3),
    ];

    // BOTH:VOLATILITY_TARGET_EXIT
    expect(
      bothDirection.volatilityTarget.directional.resolve({
        position: long,
        volatilityPoints: points,
      }).targetPoint?.id,
    ).toBe("TOP[5]");
    expect(
      bothDirection.volatilityTarget.directional.resolve({
        position: short,
        volatilityPoints: points,
      }).targetPoint?.id,
    ).toBe("BOTTOM[-4]");
  });

  it("uses the persisted vPoint time when confirmation precedes execution time", () => {
    const long = createTestPosition({
      direction: "LONG",
      entryId: "BOTTOM-A",
      entryTime: 10,
    });
    long.opened.vPoint.t = 1;

    expect(
      bothDirection.volatilityTarget.directional.resolve({
        position: long,
        volatilityPoints: [point("TOP-B", "T", 2, 5)],
      }).targetPoint?.id,
    ).toBe("TOP-B");
  });

  it("waits after an early exit until that role's directional target forms", () => {
    const main = createTestPosition({
      direction: "SHORT",
      entryId: "TOP-A",
      entryTime: 1,
      role: "MAIN",
    });
    const counter = createTestPosition({
      direction: "LONG",
      entryId: "TOP-A",
      entryTime: 1,
      role: "COUNTER",
    });
    const pairId = bothDirection.pair.resolveId(main);
    main.pairId = pairId;
    counter.pairId = pairId;
    counter.closed = {
      feeUsdt: 0,
      message: "rescued",
      price: 98,
      reason: "POST_AVERAGE_RESCUE_EXIT",
      t: 2,
    };
    const memory: TradingModelMemory = {
      positions: [main],
      positionsSell: [counter],
    };
    streakBreak.pending.reconcileClosed({ memory, position: counter });

    const waiting = streakBreak.reentry.resolve({
      positions: memory.positions,
      pendingReentries: memory.pendingReentries,
      volatilityPoints: [point("BOTTOM-B", "B", -1, 2)],
    });
    expect(waiting).toMatchObject({
      direction: "LONG",
      role: "COUNTER",
      status: "WAITING",
    });

    const ready = streakBreak.reentry.resolve({
      positions: memory.positions,
      pendingReentries: memory.pendingReentries,
      volatilityPoints: [
        point("BOTTOM-B", "B", -1, 2),
        point("TOP-C", "T", 2, 3),
      ],
    });
    expect(ready).toMatchObject({
      direction: "LONG",
      point: { id: "TOP-C" },
      role: "COUNTER",
      status: "READY",
    });
  });

  it("selects the newest unused point after an earlier re-entry was blocked", () => {
    const main = createTestPosition({
      direction: "SHORT",
      entryId: "TOP-A",
      entryTime: 1,
      role: "MAIN",
    });
    const counter = createTestPosition({
      direction: "LONG",
      entryId: "TOP-A",
      entryTime: 1,
      role: "COUNTER",
    });
    const pairId = bothDirection.pair.resolveId(main);
    main.pairId = pairId;
    counter.pairId = pairId;
    counter.closed = {
      feeUsdt: 0,
      message: "target",
      price: 102,
      reason: "VOLATILITY_TARGET_EXIT",
      t: 2,
    };
    const memory: TradingModelMemory = {
      positions: [main],
      positionsSell: [counter],
    };
    streakBreak.pending.reconcileClosed({ memory, position: counter });
    const blockedAnchor = point("TOP-B", "T", 1, 2);
    const newestAnchor = point("TOP-C", "T", 2, 3);

    const decision = streakBreak.reentry.resolve({
      positions: memory.positions,
      pendingReentries: memory.pendingReentries,
      volatilityPoints: [blockedAnchor, newestAnchor],
    });

    // BOTH:STREAK_BREAK_REENTRY
    expect(decision).toMatchObject({
      pairId,
      point: { id: "TOP-C" },
      status: "READY",
    });

    newestAnchor.usedByCounter = true;
    expect(
      streakBreak.reentry.resolve({
        positions: memory.positions,
        pendingReentries: memory.pendingReentries,
        volatilityPoints: [blockedAnchor, newestAnchor],
      }),
    ).toMatchObject({
      point: { id: "TOP-B" },
      status: "READY",
    });
  });

  it("keeps the stable pair identity after a role receives a new anchor", () => {
    const survivor = createTestPosition({
      direction: "SHORT",
      entryId: "TOP-A",
      entryTime: 1,
      role: "MAIN",
    });
    const pairId = bothDirection.pair.resolveId(survivor);
    survivor.pairId = pairId;
    const reopened = createTestPosition({
      direction: "LONG",
      entryId: "TOP-B",
      entryTime: 2,
      role: "COUNTER",
    });
    reopened.pairId = pairId;

    expect(bothDirection.pair.matches(survivor, reopened)).toBe(true);
    expect(bothDirection.pair.countOpen([survivor, reopened])).toBe(1);
  });

  it("migrates a retained closed leg into compact pending state", () => {
    const main = createTestPosition({ role: "MAIN" });
    const counter = createTestPosition({
      direction: "SHORT",
      role: "COUNTER",
    });
    const pairId = bothDirection.pair.resolveId(main);
    main.pairId = pairId;
    counter.pairId = pairId;
    counter.closed = {
      feeUsdt: 0,
      message: "target",
      price: 101,
      reason: "VOLATILITY_TARGET_EXIT",
      t: 2,
    };
    const memory: TradingModelMemory = { positions: [main, counter] };

    streakBreak.pending.normalizeMemory(memory);

    expect(memory.positions).toEqual([main]);
    expect(memory.pendingReentries).toEqual([
      {
        closeReason: "VOLATILITY_TARGET_EXIT",
        direction: "SHORT",
        opened: {
          t: counter.opened.t,
          vPoint: counter.opened.vPoint,
        },
        pairId,
        role: "COUNTER",
      },
    ]);
  });

  it("clears pair pending state when the surviving leg also closes", () => {
    const main = createTestPosition({ role: "MAIN" });
    const counter = createTestPosition({
      direction: "SHORT",
      role: "COUNTER",
    });
    const pairId = bothDirection.pair.resolveId(main);
    main.pairId = pairId;
    counter.pairId = pairId;
    counter.closed = {
      feeUsdt: 0,
      message: "counter closed",
      price: 100,
      reason: "STOP_LOSS",
      t: 2,
    };
    const memory: TradingModelMemory = { positions: [main] };
    streakBreak.pending.reconcileClosed({ memory, position: counter });
    expect(memory.pendingReentries).toHaveLength(1);

    main.closed = {
      feeUsdt: 0,
      message: "main closed",
      price: 100,
      reason: "STOP_LOSS",
      t: 3,
    };
    memory.positions = [];
    streakBreak.pending.reconcileClosed({ memory, position: main });

    expect(memory.pendingReentries).toBeUndefined();
  });
});
