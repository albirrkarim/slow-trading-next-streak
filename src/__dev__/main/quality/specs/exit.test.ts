import {
  calculateBacktestFeeAdjustedNetProfitUSDT,
  resolveBacktestExitDecision,
} from "@/lib/dynamic/backtest-volatility/exit-policy";
import { TradingMode } from "@/lib/exchange";
import { dynamicExit } from "@/lib/trading/execute/models/exit";
import { TRADE_MESSAGE } from "@/lib/trading/message";
import type {
  TradingModelConfig,
  TradingModelMemory,
} from "@/lib/trading/models";
import postAverageRescue from "@/lib/trading/post-average-rescue";
import postAverageStopLoss from "@/lib/trading/post-average-stop-loss";
import { vi } from "vitest";
import { createTestPosition } from "../fixtures/position";
import bothDirection from "@/lib/trading/both-direction";

const exchangeMocks = vi.hoisted(() => ({
  getBothSideFeePercent: vi.fn(() => 0),
}));

vi.mock("@/lib/exchange", async () => {
  const actual = await vi.importActual<any>("@/lib/exchange");
  return {
    ...actual,
    getExchange: vi.fn(() => ({
      getFees: () => ({
        getBothSideFeePercent: exchangeMocks.getBothSideFeePercent,
      }),
    })),
  };
});

function createPosition() {
  return createTestPosition({
    symbol: "SUI",
    entryPrice: 100,
    entryTime: 1,
    notionalUsdt: 100,
    quantity: 1,
    direction: "LONG",
    tradingMode: TradingMode.SPOT,
  });
}

function createAveragedPosition(completedAveragingCount = 1) {
  return createTestPosition({
    symbol: "SUI",
    entryPrice: 100,
    entryTime: 1,
    notionalUsdt: 100,
    quantity: 1,
    tradingMode: TradingMode.SPOT,
    averaging: {
      entryLevel: -2,
      lastHandledLevel: -2 - completedAveragingCount,
      reserveBaseMarginUsdt: 100,
      reservedRemainingMarginUsdt: 0,
      steps: Array.from({ length: completedAveragingCount }, (_, index) => ({
        level: -3 - index,
        marginUsdt: 10,
        allocationPct: 2,
        status: "USED" as const,
      })),
      executions: Array.from(
        { length: completedAveragingCount },
        (_, index) => ({
          t: 2 + index,
          level: -3 - index,
          marginUsdt: 10,
          price: 95,
          allocationPct: 2,
        }),
      ),
    },
  });
}

function buildKline(time: number, price: number) {
  return [
    time,
    String(price),
    String(price),
    String(price),
    String(price),
    "100",
  ] as any;
}

function createMemory(): TradingModelMemory {
  return {
    positions: [createPosition()],
    positionsSell: [],
    volatility: {
      symbol: "SUI",
      lastVolatility: [],
    },
  } as any;
}

function createRescueMemory(completedAveragingCount: number) {
  return {
    positions: [createAveragedPosition(completedAveragingCount)],
    positionsSell: [],
    volatility: {
      symbol: "SUI",
      lastVolatility: [
        {
          id: "BOTTOM[-3]",
          l: "B",
          lvl: -3,
          pct: 5,
          p: 90,
          t: 2,
          vb: 1,
          vq: 90,
        },
      ],
    },
  } as TradingModelMemory;
}

const rescueExitConfig: TradingModelConfig = {
  takeProfitPercent: 5,
  stopLossPercent: 90,
  useStopLossPlus: true,
  stopLossPlusTrigger: 1,
  orderType: "taker",
};

describe("slow specs exit", () => {
  it("preserves legacy one-way merged exits when multiple lots are stored", async () => {
    const memory = {
      positions: [
        createTestPosition({ entryId: "lot-1", quantity: 1 }),
        createTestPosition({ entryId: "lot-2", quantity: 2 }),
      ],
      positionsSell: [],
      volatility: { symbol: "SUI", lastVolatility: [] },
    } as TradingModelMemory;

    const exit = await dynamicExit({
      bypass: true,
      symbol: "SUI",
      current: buildKline(2, 10),
      config: { takeProfitPercent: 5 },
      memory,
      exchangeType: "tokocrypto",
      tradingMode: TradingMode.SPOT,
    });

    expect(exit).toMatchObject({ action: "SELL", amount: 3 });
    expect(memory.positions).toHaveLength(0);
    expect(memory.positionsSell).toHaveLength(2);
  });

  it("closes only the SHORT leg at the next confirmed BOTTOM", async () => {
    const main = createTestPosition({
      direction: "SHORT",
      entryId: "TOP[1]",
      entryLevel: 1,
      entryPrice: 100,
      entryTime: 1,
      role: "MAIN",
      symbol: "APT",
    });
    const counter = createTestPosition({
      direction: "LONG",
      entryId: "TOP[1]",
      entryLevel: 1,
      entryPrice: 100,
      entryTime: 1,
      role: "COUNTER",
      symbol: "APT",
    });
    const memory = {
      positions: [main, counter],
      positionsSell: [],
      volatility: {
        symbol: "SUI",
        lastVolatility: [
          { id: "BOTTOM[0]", l: "B", lvl: 0, p: 100, pct: 2, t: 2, vb: 1, vq: 1 },
        ],
      },
    } as TradingModelMemory;

    const first = await dynamicExit({
      symbol: "SUI",
      current: buildKline(2, 100),
      config: {
        stopLossPercent: 90,
        stopLossUSDT: 0,
        takeProfitPercent: 100,
        useStopLossPlus: false,
      },
      memory,
      exchangeType: "tokocrypto",
      positionRole: "MAIN",
      tradingMode: TradingMode.SPOT,
    });
    const second = await dynamicExit({
      symbol: "SUI",
      current: buildKline(2, 100),
      config: {
        stopLossPercent: 90,
        stopLossUSDT: 0,
        takeProfitPercent: 100,
        useStopLossPlus: false,
      },
      memory,
      exchangeType: "tokocrypto",
      positionRole: "COUNTER",
      tradingMode: TradingMode.SPOT,
    });

    // BOTH:VOLATILITY_TARGET_EXIT
    expect(first.reason).toContain("BOTH:VOLATILITY_TARGET_EXIT");
    expect(second.action).toBe("HOLD");
    expect(memory.positions).toHaveLength(1);
    expect(memory.positionsSell?.map((position) => position.closed?.reason)).toEqual([
      "VOLATILITY_TARGET_EXIT",
    ]);
  });

  it("retries a reached pair target after the exact target cycle was missed", async () => {
    const main = createTestPosition({
      direction: "SHORT",
      entryId: "TOP[0]",
      entryLevel: 0,
      entryPrice: 100,
      entryTime: 1,
      role: "MAIN",
      symbol: "APT",
    });
    const counter = createTestPosition({
      direction: "LONG",
      entryId: "TOP[0]",
      entryLevel: 0,
      entryPrice: 100,
      entryTime: 1,
      role: "COUNTER",
      symbol: "APT",
    });
    const memory = {
      positions: [main, counter],
      positionsSell: [],
      volatility: {
        symbol: "APT",
        lastVolatility: [
          { id: "TOP[1]", l: "T", lvl: 1, p: 105, pct: 5, t: 2, vb: 1, vq: 1 },
          { id: "BOTTOM[0]", l: "B", lvl: 0, p: 100, pct: 5, t: 3, vb: 1, vq: 1 },
          { id: "TOP[1]-LATER", l: "T", lvl: 1, p: 101, pct: 1, t: 4, vb: 1, vq: 1 },
        ],
      },
    } as TradingModelMemory;
    const config = {
      stopLossPercent: 90,
      stopLossUSDT: 0,
      takeProfitPercent: 100,
      useStopLossPlus: false,
    };

    const first = await dynamicExit({
      symbol: "APT",
      current: buildKline(4, 101),
      config,
      memory,
      exchangeType: "tokocrypto",
      positionRole: "MAIN",
      tradingMode: TradingMode.FUTURES,
    });
    const second = await dynamicExit({
      symbol: "APT",
      current: buildKline(4, 101),
      config,
      memory,
      exchangeType: "tokocrypto",
      positionRole: "COUNTER",
      tradingMode: TradingMode.FUTURES,
    });

    // BOTH:VOLATILITY_TARGET_EXIT
    expect(first.reason).toContain("BOTH:VOLATILITY_TARGET_EXIT");
    expect(second.action).toBe("SELL");
    expect(memory.positions).toHaveLength(0);
    expect(memory.positionsSell?.map((position) => position.closed?.reason)).toEqual([
      "VOLATILITY_TARGET_EXIT",
      "VOLATILITY_TARGET_EXIT",
    ]);
  });

  it.each([
    {
      name: "BOTTOM -2 -> TOP 0",
      entryLevel: -2,
      points: [{ id: "TOP[0]", l: "T", lvl: 0, t: 2 }],
      targetId: "TOP[0]",
    },
    {
      name: "TOP 1 -> TOP 2 -> TOP 3 -> BOTTOM 0",
      entryLevel: 1,
      points: [
        { id: "TOP[2]", l: "T", lvl: 2, t: 2 },
        { id: "TOP[3]", l: "T", lvl: 3, t: 3 },
        { id: "BOTTOM[0]", l: "B", lvl: 0, t: 4 },
      ],
      targetId: "BOTTOM[0]",
    },
    {
      name: "BOTTOM 0 -> TOP 1 -> BOTTOM 0",
      entryLevel: 0,
      points: [
        { id: "TOP[1]", l: "T", lvl: 1, t: 2 },
        { id: "BOTTOM[0]-RETURN", l: "B", lvl: 0, t: 3 },
      ],
      targetId: "BOTTOM[0]-RETURN",
    },
    {
      name: "BOTTOM 0 -> BOTTOM -1 -> TOP 0",
      entryLevel: 0,
      points: [
        { id: "BOTTOM[-1]", l: "B", lvl: -1, t: 2 },
        { id: "TOP[0]", l: "T", lvl: 0, t: 3 },
      ],
      targetId: "TOP[0]",
    },
  ])("resolves the documented volatility target for $name", ({ entryLevel, points, targetId }) => {
    const position = createTestPosition({
      entryId: `ENTRY[${entryLevel}]`,
      entryLevel,
      entryTime: 1,
    });
    const state = bothDirection.volatilityTarget.levelZero.resolve({
      position,
      volatilityPoints: points as any,
    });

    // BOTH:VOLATILITY_TARGET_EXIT
    // BOTH:VOLATILITY_TARGET_SL_VALUE
    // BOTH:VOLATILITY_TARGET_TP
    expect(state).toMatchObject({
      hasReached: true,
      isCurrent: true,
      targetPoint: { id: targetId },
    });
  });

  it("treats the next BOTTOM as the SHORT target regardless of numeric level", async () => {
    const main = createTestPosition({
      direction: "SHORT",
      entryId: "TOP[0]",
      entryLevel: 0,
      entryPrice: 0.5462,
      entryTime: 1,
      role: "MAIN",
    });
    const counter = createTestPosition({
      direction: "LONG",
      entryId: "TOP[0]",
      entryLevel: 0,
      entryPrice: 0.5462,
      entryTime: 1,
      role: "COUNTER",
    });
    const memory = {
      positions: [main, counter],
      positionsSell: [],
      volatility: {
        symbol: "APT",
        lastVolatility: [
          { id: "TOP[0]", l: "T", lvl: 0, p: 0.5462, pct: 0, t: 1, vb: 1, vq: 1 },
          { id: "BOTTOM[-1]", l: "B", lvl: -1, p: 0.5283, pct: 3, t: 2, vb: 1, vq: 1 },
        ],
      },
    } as TradingModelMemory;
    const config = {
      stopLossPercent: 15,
      takeProfitPercent: 100,
      volatilityTargetStopLossPercent: 3,
      useStopLossPlus: false,
    };

    const mainExit = await dynamicExit({
      symbol: "APT",
      current: buildKline(2, 0.5283),
      config,
      memory,
      exchangeType: "tokocrypto",
      positionRole: "MAIN",
      tradingMode: TradingMode.FUTURES,
    });
    const counterExit = await dynamicExit({
      symbol: "APT",
      current: buildKline(2, 0.5283),
      config,
      memory,
      exchangeType: "tokocrypto",
      positionRole: "COUNTER",
      tradingMode: TradingMode.FUTURES,
    });

    // BOTH:VOLATILITY_TARGET_EXIT
    // BOTH:VOLATILITY_TARGET_SL_VALUE
    // BOTH:VOLATILITY_TARGET_TP
    expect(mainExit.action).toBe("SELL");
    expect(counterExit.action).toBe("HOLD");
    expect(memory.positions).toHaveLength(1);
    expect(memory.positionsSell).toHaveLength(1);
  });

  it("leaves the counterpart open when one leg hits traditional hard SL", async () => {
    const memory = {
      positions: [
        createTestPosition({
          direction: "LONG",
          entryPrice: 100,
          role: "MAIN",
        }),
        createTestPosition({
          direction: "SHORT",
          entryPrice: 100,
          role: "COUNTER",
        }),
      ],
      positionsSell: [],
      volatility: { symbol: "SUI", lastVolatility: [] },
    } as TradingModelMemory;
    const config: TradingModelConfig = {
      stopLossPercent: 10,
      stopLossUSDT: 0,
      takeProfitPercent: 100,
      useStopLossPlus: false,
    };

    const first = await dynamicExit({
      symbol: "SUI",
      current: buildKline(2, 89),
      config,
      memory,
      exchangeType: "tokocrypto",
      positionRole: "MAIN",
      tradingMode: TradingMode.SPOT,
    });
    expect(first.category).toBe(TRADE_MESSAGE.sell.SL);
    expect(memory.positions).toHaveLength(1);
    expect(
      memory.positions.find((position) => !position.closed)?.control?.forceExit,
    ).toBeUndefined();

    await dynamicExit({
      symbol: "SUI",
      current: buildKline(2, 89),
      config,
      memory,
      exchangeType: "tokocrypto",
      positionRole: "COUNTER",
      tradingMode: TradingMode.SPOT,
    });

    // BOTH:INDEPENDENT_LEG_STOP_LOSS
    // PROD:OPEN_POSITION_BOTH_LEG
    expect(memory.positions).toHaveLength(1);
    expect(memory.positionsSell?.map((position) => position.closed?.reason)).toEqual([
      "STOP_LOSS",
    ]);
  });

  it("manually closes only the requested counter leg", async () => {
    const main = createTestPosition({
      direction: "LONG",
      role: "MAIN",
    });
    const counter = createTestPosition({
      direction: "SHORT",
      role: "COUNTER",
    });
    counter.control = {
      forceExit: {
        closeReason: "FINAL",
        reason: "Position was manually exited",
      },
    };
    const memory = {
      positions: [main, counter],
      positionsSell: [],
      volatility: { symbol: "SUI", lastVolatility: [] },
    } as TradingModelMemory;

    const exit = await dynamicExit({
      symbol: "SUI",
      current: buildKline(2, 10),
      config: { takeProfitPercent: 100 },
      memory,
      exchangeType: "tokocrypto",
      positionRole: "COUNTER",
      tradingMode: TradingMode.FUTURES,
    });

    // PROD:MANUAL_EXIT_POSITION_ROLE
    expect(exit).toMatchObject({ action: "SELL", position: { role: "COUNTER" } });
    expect(main.closed).toBeUndefined();
    expect(main.control?.forceExit).toBeUndefined();
    expect(counter.closed?.reason).toBe("FINAL");
  });

  it("disables percentage take profit for both streak-break roles", async () => {
    const main = createTestPosition({
      direction: "LONG",
      role: "MAIN",
    });
    const counter = createTestPosition({
      direction: "SHORT",
      role: "COUNTER",
    });
    const memory = {
      positions: [main, counter],
      positionsSell: [],
      volatility: { symbol: "SUI", lastVolatility: [] },
    } as TradingModelMemory;

    const exit = await dynamicExit({
      symbol: "SUI",
      current: buildKline(2, 11),
      config: {
        stopLossPercent: 90,
        stopLossUSDT: 0,
        takeProfitPercent: 5,
        useStopLossPlus: false,
      },
      memory,
      exchangeType: "tokocrypto",
      positionRole: "MAIN",
      tradingMode: TradingMode.FUTURES,
    });

    // BOTH:STREAK_BREAK_REENTRY
    expect(exit.action).toBe("HOLD");
    expect(main.closed).toBeUndefined();
  });

  it.each([
    {
      counterpartRole: "COUNTER" as const,
      price: 5,
      triggerRole: "MAIN" as const,
    },
    {
      counterpartRole: "MAIN" as const,
      price: 15,
      triggerRole: "COUNTER" as const,
    },
  ])(
    "keeps $counterpartRole open when net USDT loss stops $triggerRole",
    async ({ counterpartRole, price, triggerRole }) => {
      const memory = {
        positions: [
          createTestPosition({ direction: "LONG", role: "MAIN" }),
          createTestPosition({ direction: "SHORT", role: "COUNTER" }),
        ],
        positionsSell: [],
        volatility: { symbol: "SUI", lastVolatility: [] },
      } as TradingModelMemory;

      const exit = await dynamicExit({
        symbol: "SUI",
        current: buildKline(2, price),
        config: {
          stopLossPercent: 90,
          stopLossUSDT: 5,
          takeProfitPercent: 100,
          useStopLossPlus: false,
        },
        memory,
        exchangeType: "tokocrypto",
        positionRole: triggerRole,
        tradingMode: TradingMode.SPOT,
      });

      // BOTH:STOP_LOSS_BY_USDT_LOSS
      // BOTH:INDEPENDENT_LEG_STOP_LOSS
      expect(exit.reason).toContain("BOTH:STOP_LOSS_BY_USDT_LOSS");
      expect(memory.positions).toHaveLength(1);
      expect(memory.positionsSell?.at(-1)?.closed?.reason).toBe(
        "STOP_LOSS_BY_USDT_LOSS",
      );
      const counterpart = memory.positions.find(
        (position) => position.role === counterpartRole,
      );
      expect(counterpart?.closed).toBeUndefined();
      expect(counterpart?.control?.forceExit).toBeUndefined();

      await dynamicExit({
        symbol: "SUI",
        current: buildKline(2, price),
        config: {
          stopLossPercent: 90,
          stopLossUSDT: 5,
          takeProfitPercent: 100,
          useStopLossPlus: false,
        },
        memory,
        exchangeType: "tokocrypto",
        positionRole: counterpartRole,
        tradingMode: TradingMode.SPOT,
      });

      expect(memory.positions).toHaveLength(1);
      expect(
        memory.positionsSell?.map((position) => position.closed?.reason),
      ).toEqual([
        "STOP_LOSS_BY_USDT_LOSS",
      ]);
    },
  );

  it("exits at the configured absolute latest vPoint level", async () => {
    const memory = createMemory();
    memory.volatility!.lastVolatility = [
      {
        id: "BOTTOM[-6]",
        l: "B",
        lvl: -6,
        pct: 5,
        p: 90,
        t: 2,
        vb: 1,
        vq: 90,
      },
    ];

    const exit = await dynamicExit({
      symbol: "SUI",
      current: buildKline(3, 100),
      config: {
        exitOnVPointAbsLevel: 6,
        stopLossPercent: 90,
        stopLossUSDT: 0,
        takeProfitPercent: 5,
      },
      memory,
      exchangeType: "tokocrypto",
      tradingMode: TradingMode.SPOT,
    });

    // BOTH:EXIT_ON_VPOINT_LEVEL
    expect(exit).toMatchObject({
      action: "SELL",
      category: TRADE_MESSAGE.sell.SL,
    });
    expect(exit.reason).toContain("BOTH:EXIT_ON_VPOINT_LEVEL");
    expect(memory.positionsSell?.[0].closed?.reason).toBe(
      "EXIT_ON_VPOINT_LEVEL",
    );
  });

  it("disables the absolute vPoint exit at level zero", async () => {
    const memory = createMemory();
    memory.volatility!.lastVolatility = [
      {
        id: "BOTTOM[-8]",
        l: "B",
        lvl: -8,
        pct: 5,
        p: 90,
        t: 2,
        vb: 1,
        vq: 90,
      },
    ];

    const exit = await dynamicExit({
      symbol: "SUI",
      current: buildKline(3, 100),
      config: {
        exitOnVPointAbsLevel: 0,
        stopLossPercent: 90,
        stopLossUSDT: 0,
        takeProfitPercent: 5,
      },
      memory,
      exchangeType: "tokocrypto",
      tradingMode: TradingMode.SPOT,
    });

    // BOTH:EXIT_ON_VPOINT_LEVEL
    expect(exit.action).toBe("HOLD");
    expect(memory.positionsSell).toHaveLength(0);
  });

  it("exits at the default net USDT loss limit", async () => {
    const memory = createMemory();

    const exit = await dynamicExit({
      symbol: "SUI",
      current: buildKline(3, 50),
      config: {
        stopLossPercent: 90,
        takeProfitPercent: 5,
      },
      memory,
      exchangeType: "tokocrypto",
      tradingMode: TradingMode.SPOT,
    });

    // BOTH:STOP_LOSS_BY_USDT_LOSS
    expect(exit).toMatchObject({
      action: "SELL",
      category: TRADE_MESSAGE.sell.SL,
    });
    expect(exit.reason).toContain("BOTH:STOP_LOSS_BY_USDT_LOSS");
    expect(memory.positionsSell?.[0].closed?.reason).toBe(
      "STOP_LOSS_BY_USDT_LOSS",
    );
  });

  it("disables the net USDT stop loss at zero", async () => {
    const memory = createMemory();

    const exit = await dynamicExit({
      symbol: "SUI",
      current: buildKline(3, 50),
      config: {
        stopLossPercent: 90,
        stopLossUSDT: 0,
        takeProfitPercent: 5,
      },
      memory,
      exchangeType: "tokocrypto",
      tradingMode: TradingMode.SPOT,
    });

    // BOTH:STOP_LOSS_BY_USDT_LOSS
    expect(exit.action).toBe("HOLD");
    expect(memory.positionsSell).toHaveLength(0);
  });

  it("applies the fee-adjusted net USDT stop loss in backtest", () => {
    const position = createPosition();
    position.fees.entryUsdt = 0.1;
    const modelConfig = {
      stopLossPercent: 90,
      stopLossUSDT: 5,
      takeProfitPercent: 100,
    };
    const beforeFeeAdjustedLimit = resolveBacktestExitDecision({
      position,
      currentPrice: 95.2,
      exitFeeRatio: 0.001,
      forceSell: false,
      globalLiquidation: false,
      modelConfig,
    });
    const afterFeeAdjustedLimit = resolveBacktestExitDecision({
      position,
      currentPrice: 95.19,
      exitFeeRatio: 0.001,
      forceSell: false,
      globalLiquidation: false,
      modelConfig,
    });

    // BOTH:STOP_LOSS_BY_USDT_LOSS
    expect(beforeFeeAdjustedLimit.shouldExit).toBe(false);
    expect(afterFeeAdjustedLimit).toMatchObject({
      category: TRADE_MESSAGE.sell.SL,
      shouldExit: true,
    });
    expect(afterFeeAdjustedLimit.exitPrice).toBeCloseTo(95.195195);
    expect(
      calculateBacktestFeeAdjustedNetProfitUSDT(
        position,
        afterFeeAdjustedLimit.exitPrice,
        0.001,
      ),
    ).toBeCloseTo(-5);
    expect(afterFeeAdjustedLimit.message).toContain(
      "BOTH:STOP_LOSS_BY_USDT_LOSS",
    );
  });

  it("exits backtest at the configured absolute vPoint level", () => {
    const exit = resolveBacktestExitDecision({
      position: createPosition(),
      currentPrice: 100,
      currentVolatilityLevel: -6,
      forceSell: false,
      globalLiquidation: false,
      modelConfig: {
        exitOnVPointAbsLevel: 6,
        stopLossPercent: 90,
        stopLossUSDT: 0,
        takeProfitPercent: 100,
      },
    });

    // BOTH:EXIT_ON_VPOINT_LEVEL
    expect(exit).toMatchObject({
      category: TRADE_MESSAGE.sell.SL,
      exitPrice: 100,
      shouldExit: true,
    });
    expect(exit.message).toContain("BOTH:EXIT_ON_VPOINT_LEVEL");
  });

  it("disables the backtest absolute vPoint exit at level zero", () => {
    const decision = resolveBacktestExitDecision({
      position: createPosition(),
      currentPrice: 100,
      currentVolatilityLevel: -8,
      forceSell: false,
      globalLiquidation: false,
      modelConfig: {
        exitOnVPointAbsLevel: 0,
        stopLossPercent: 90,
        stopLossUSDT: 0,
        takeProfitPercent: 100,
      },
    });

    // BOTH:EXIT_ON_VPOINT_LEVEL
    expect(decision.shouldExit).toBe(false);
  });

  it("disables the backtest net USDT stop loss at zero", () => {
    const decision = resolveBacktestExitDecision({
      position: createPosition(),
      currentPrice: 50,
      exitFeeRatio: 0.001,
      forceSell: false,
      globalLiquidation: false,
      modelConfig: {
        stopLossPercent: 90,
        stopLossUSDT: 0,
        takeProfitPercent: 100,
      },
    });

    // BOTH:STOP_LOSS_BY_USDT_LOSS
    expect(decision.shouldExit).toBe(false);
  });

  it("supports traditional TP and SL percent exits", () => {
    const tpNotYetHitTargetZone = resolveBacktestExitDecision({
      position: createPosition() as any,
      currentPrice: 106,
      forceSell: false,
      globalLiquidation: false,
      hasHitProfitZone: false, // not hit the direction-specific profit zone
      modelConfig: {
        takeProfitPercent: 5,
        stopLossPercent: 10,
      },
    });

    // BOTH:TRADITIONAL_TP_SL
    expect(tpNotYetHitTargetZone.shouldExit).toBe(false);

    const tp = resolveBacktestExitDecision({
      position: createPosition() as any,
      currentPrice: 106,
      forceSell: false,
      globalLiquidation: false,
      hasHitProfitZone: true,
      modelConfig: {
        takeProfitPercent: 5,
        stopLossPercent: 10,
      },
    });

    // BOTH:TRADITIONAL_TP_SL
    expect(tp.shouldExit).toBe(true);
    expect(tp.category).toBe(TRADE_MESSAGE.sell.TP);

    const sl = resolveBacktestExitDecision({
      position: createPosition() as any,
      currentPrice: 89,
      forceSell: false,
      globalLiquidation: false,
      modelConfig: {
        takeProfitPercent: 5,
        stopLossPercent: 10,
      },
    });

    // BOTH:TRADITIONAL_TP_SL
    expect(sl.shouldExit).toBe(true);
    expect(sl.category).toBe(TRADE_MESSAGE.sell.SL);
  });

  it("uses unlevered price PnL for backtest TP/SL and leveraged PnL for liquidation", () => {
    const leveragedPosition = {
      ...createPosition(),
      exposure: {
        ...createPosition().exposure,
        leverage: 3,
      },
    };
    const modelConfig = {
      takeProfitPercent: 5,
      stopLossPercent: 5,
    };

    const noTp = resolveBacktestExitDecision({
      position: leveragedPosition as any,
      currentPrice: 102,
      forceSell: false,
      globalLiquidation: false,
      modelConfig,
    });

    // BOTH:TRADITIONAL_TP_SL
    expect(noTp.shouldExit).toBe(false);
    expect(noTp.netProfitPercent).toBe(2);

    const noSl = resolveBacktestExitDecision({
      position: leveragedPosition as any,
      currentPrice: 96,
      forceSell: false,
      globalLiquidation: false,
      modelConfig,
    });

    // BOTH:TRADITIONAL_TP_SL
    expect(noSl.shouldExit).toBe(false);
    expect(noSl.netProfitPercent).toBe(-4);

    const liquidated = resolveBacktestExitDecision({
      position: leveragedPosition as any,
      currentPrice: 73,
      forceSell: false,
      globalLiquidation: false,
      modelConfig: {
        ...modelConfig,
        stopLossPercent: 90,
      },
    });

    expect(liquidated.shouldExit).toBe(true);
    expect(liquidated.category).toBe(TRADE_MESSAGE.sell.LIQUIDATED_ISOLATED);
    expect(liquidated.netProfitPercent).toBe(-100);
  });

  it("records the custom force-sell reason in backtest exit decisions", () => {
    const exit = resolveBacktestExitDecision({
      position: {
        ...createPosition(),
        control: {
          forceExit: {
            reason:
              "BOTH:EXIT_SIDEWAYS_TO_ENTRY_STRONG_CANDIDATES | free worker",
          },
        },
      },
      currentPrice: 100,
      forceSell: true,
      globalLiquidation: false,
      modelConfig: {
        takeProfitPercent: 5,
      },
    });

    // BOTH:EXIT_SIDEWAYS_TO_ENTRY_STRONG_CANDIDATES
    expect(exit.shouldExit).toBe(true);
    expect(exit.message).toContain(
      "BOTH:EXIT_SIDEWAYS_TO_ENTRY_STRONG_CANDIDATES",
    );
  });

  it("exits backtest with TP after the shared volatility target is reached", () => {
    const exit = resolveBacktestExitDecision({
      position: createPosition() as any,
      currentPrice: 102,
      forceSell: false,
      globalLiquidation: false,
      hasReachedVolatilityTarget: true,
      modelConfig: {
        takeProfitPercent: 5,
        stopLossPercent: 10,
      },
    });

    // BOTH:VOLATILITY_TARGET_TP
    expect(exit.shouldExit).toBe(true);
    expect(exit.category).toBe(TRADE_MESSAGE.sell.TP);
    expect(exit.netProfitPercent).toBe(2);
  });

  it("keeps backtest open when target profit does not cover fees", () => {
    const exit = resolveBacktestExitDecision({
      position: createPosition() as any,
      currentPrice: 100.1,
      forceSell: false,
      globalLiquidation: false,
      hasReachedVolatilityTarget: true,
      modelConfig: {
        takeProfitPercent: 5,
        stopLossPercent: 10,
      },
    });

    // BOTH:VOLATILITY_TARGET_TP
    expect(exit.shouldExit).toBe(false);
  });

  it("applies the fee-adjusted volatility-target stop loss in backtest", () => {
    const beforeTarget = resolveBacktestExitDecision({
      position: createPosition() as any,
      currentPrice: 98.1,
      forceSell: false,
      globalLiquidation: false,
      hasReachedVolatilityTarget: false,
      modelConfig: {
        takeProfitPercent: 5,
        stopLossPercent: 20,
        volatilityTargetStopLossPercent: 2,
      },
    });
    const disabled = resolveBacktestExitDecision({
      position: createPosition() as any,
      currentPrice: 97,
      forceSell: false,
      globalLiquidation: false,
      hasReachedVolatilityTarget: true,
      modelConfig: {
        takeProfitPercent: 5,
        stopLossPercent: 20,
        volatilityTargetStopLossPercent: 0,
      },
    });
    const triggered = resolveBacktestExitDecision({
      position: createPosition() as any,
      currentPrice: 98.1,
      forceSell: false,
      globalLiquidation: false,
      hasReachedVolatilityTarget: true,
      modelConfig: {
        takeProfitPercent: 5,
        stopLossPercent: 20,
        volatilityTargetStopLossPercent: 2,
      },
    });

    // BOTH:VOLATILITY_TARGET_SL_VALUE
    expect(beforeTarget.shouldExit).toBe(false);
    expect(disabled.shouldExit).toBe(false);
    expect(triggered).toMatchObject({
      category: TRADE_MESSAGE.sell.SL,
      netProfitPercent: expect.closeTo(-2),
      shouldExit: true,
    });
    expect(triggered.message).toContain("BOTH:VOLATILITY_TARGET_SL_VALUE");
  });

  it("applies the fee-adjusted volatility-target stop loss in production", async () => {
    exchangeMocks.getBothSideFeePercent.mockReturnValueOnce(0.2);
    const memory = createMemory();
    memory.volatility = {
      symbol: "SUI",
      lastVolatility: [
        {
          id: "TOP[1]",
          l: "T",
          lvl: 1,
          pct: 3,
          p: 103,
          t: 2,
          vb: 1,
          vq: 103,
        },
        {
          id: "BOTTOM[0]",
          l: "B",
          lvl: 0,
          pct: 3,
          p: 100,
          t: 3,
          vb: 1,
          vq: 100,
        },
      ],
    };

    const exit = await dynamicExit({
      symbol: "SUI",
      current: buildKline(4, 98.1),
      config: {
        takeProfitPercent: 5,
        stopLossPercent: 20,
        volatilityTargetStopLossPercent: 2,
        orderType: "taker",
      },
      memory,
      exchangeType: "tokocrypto",
      tradingMode: TradingMode.SPOT,
    });

    // BOTH:VOLATILITY_TARGET_SL_VALUE
    expect(exit.action).toBe("SELL");
    expect(exit.category).toBe(TRADE_MESSAGE.sell.SL);
    expect(exit.profit).toBeCloseTo(-0.021);
    expect(exit.reason).toContain("BOTH:VOLATILITY_TARGET_SL_VALUE");
  });

  it("uses non-zero then zero as the SHORT volatility target", async () => {
    const memory = createMemory();
    memory.positions = [
      createTestPosition({
        direction: "SHORT",
        entryPrice: 100,
        notionalUsdt: 100,
        symbol: "SUI",
        tradingMode: TradingMode.SPOT,
      }),
    ];
    memory.volatility = {
      symbol: "SUI",
      lastVolatility: [
        {
          id: "BOTTOM[-1]",
          l: "B",
          lvl: -1,
          pct: 3,
          p: 97,
          t: 2,
          vb: 1,
          vq: 97,
        },
        {
          id: "TOP[0]",
          l: "T",
          lvl: 0,
          pct: 3,
          p: 100,
          t: 3,
          vb: 1,
          vq: 100,
        },
      ],
    };

    const exit = await dynamicExit({
      symbol: "SUI",
      current: buildKline(4, 102.1),
      config: {
        takeProfitPercent: 5,
        stopLossPercent: 20,
        volatilityTargetStopLossPercent: 2,
        orderType: "taker",
      },
      memory,
      exchangeType: "tokocrypto",
      tradingMode: TradingMode.SPOT,
    });

    // BOTH:VOLATILITY_TARGET_SL_VALUE
    expect(exit.action).toBe("SELL");
    expect(exit.category).toBe(TRADE_MESSAGE.sell.SL);
  });

  it.each([
    { count: 0, netPnlPercent: 10, expected: false },
    { count: 1, netPnlPercent: 0.499, expected: false },
    { count: 1, netPnlPercent: 0.5, expected: true },
    { count: 2, netPnlPercent: 0, expected: true },
    { count: 2, netPnlPercent: 0.001, expected: true },
    { count: 3, netPnlPercent: -0.501, expected: false },
    { count: 3, netPnlPercent: -0.5, expected: true },
    { count: 4, netPnlPercent: -0.5, expected: true },
  ])(
    "applies the rescue net-PnL boundary after $count averaging executions",
    ({ count, netPnlPercent, expected }) => {
      const result = postAverageRescue.evaluate({
        currentPrice: 110,
        direction: "LONG",
        lastVolatilityPrice: 100,
        netPnlPercent,
        position: createAveragedPosition(count),
      });

      // BOTH:POST_AVERAGE_RESCUE_EXIT
      expect(result.shouldExit).toBe(expected);
    },
  );

  it("uses the greatest configured averaging threshold reached", () => {
    const config = {
      enabled: true,
      thresholds: [
        { minAveragingCount: 1, minNetPnlPct: 2 },
        { minAveragingCount: 3, minNetPnlPct: -1 },
      ],
    };

    const afterTwo = postAverageRescue.evaluate({
      config,
      currentPrice: 110,
      direction: "LONG",
      lastVolatilityPrice: 100,
      netPnlPercent: 1,
      position: createAveragedPosition(2),
    });
    const afterFour = postAverageRescue.evaluate({
      config,
      currentPrice: 110,
      direction: "LONG",
      lastVolatilityPrice: 100,
      netPnlPercent: -1,
      position: createAveragedPosition(4),
    });

    // BOTH:POST_AVERAGE_RESCUE_EXIT
    expect(afterTwo.minimumNetPnlPercent).toBe(2);
    expect(afterTwo.shouldExit).toBe(false);
    expect(afterFour.minimumNetPnlPercent).toBe(-1);
    expect(afterFour.shouldExit).toBe(true);
  });

  it("does not request a rescue exit when the rule is disabled", () => {
    const result = postAverageRescue.evaluate({
      config: {
        enabled: false,
        thresholds: [{ minAveragingCount: 1, minNetPnlPct: -100 }],
      },
      currentPrice: 110,
      direction: "LONG",
      lastVolatilityPrice: 100,
      netPnlPercent: 10,
      position: createAveragedPosition(1),
    });

    // BOTH:POST_AVERAGE_RESCUE_EXIT
    expect(result.minimumNetPnlPercent).toBeUndefined();
    expect(result.shouldExit).toBe(false);
  });

  it("uses the greatest reached post-average stop-loss tier", () => {
    const config = {
      enabled: true,
      thresholds: [
        { minAveragingCount: 1, maxNetPnlPct: -5, maxNetPnlUsdt: 0 },
        { minAveragingCount: 3, maxNetPnlPct: -2, maxNetPnlUsdt: -25 },
      ],
    };

    const afterTwo = postAverageStopLoss.evaluate({
      config,
      netPnlPercent: -3,
      netPnlUsdt: -10,
      position: createAveragedPosition(2),
    });
    const afterFour = postAverageStopLoss.evaluate({
      config,
      netPnlPercent: -2,
      netPnlUsdt: -10,
      position: createAveragedPosition(4),
    });

    // BOTH:POST_AVERAGE_STOP_LOSS
    expect(afterTwo.threshold?.minAveragingCount).toBe(1);
    expect(afterTwo.shouldExit).toBe(false);
    expect(afterFour.threshold?.minAveragingCount).toBe(3);
    expect(afterFour.hitPercent).toBe(true);
    expect(afterFour.shouldExit).toBe(true);
  });

  it.each([
    {
      label: "percentage boundary",
      maxNetPnlPct: -5,
      maxNetPnlUsdt: 0,
      netPnlPercent: -5,
      netPnlUsdt: -1,
      expectedPercent: true,
      expectedUsdt: false,
    },
    {
      label: "USDT boundary",
      maxNetPnlPct: 0,
      maxNetPnlUsdt: -20,
      netPnlPercent: -1,
      netPnlUsdt: -20,
      expectedPercent: false,
      expectedUsdt: true,
    },
    {
      label: "either active boundary",
      maxNetPnlPct: -10,
      maxNetPnlUsdt: -20,
      netPnlPercent: -2,
      netPnlUsdt: -20,
      expectedPercent: false,
      expectedUsdt: true,
    },
  ])(
    "exits at the post-average $label",
    ({
      expectedPercent,
      expectedUsdt,
      maxNetPnlPct,
      maxNetPnlUsdt,
      netPnlPercent,
      netPnlUsdt,
    }) => {
      const result = postAverageStopLoss.evaluate({
        config: {
          enabled: true,
          thresholds: [
            { minAveragingCount: 1, maxNetPnlPct, maxNetPnlUsdt },
          ],
        },
        netPnlPercent,
        netPnlUsdt,
        position: createAveragedPosition(1),
      });

      // BOTH:POST_AVERAGE_STOP_LOSS
      expect(result.hitPercent).toBe(expectedPercent);
      expect(result.hitUsdt).toBe(expectedUsdt);
      expect(result.shouldExit).toBe(true);
    },
  );

  it("treats zero post-average loss boundaries as independently disabled", () => {
    const result = postAverageStopLoss.evaluate({
      config: {
        enabled: true,
        thresholds: [
          { minAveragingCount: 1, maxNetPnlPct: 0, maxNetPnlUsdt: 0 },
        ],
      },
      netPnlPercent: -100,
      netPnlUsdt: -100,
      position: createAveragedPosition(1),
    });

    // BOTH:POST_AVERAGE_STOP_LOSS
    expect(result.hitPercent).toBe(false);
    expect(result.hitUsdt).toBe(false);
    expect(result.shouldExit).toBe(false);
  });

  it("keeps the post-average stop disabled for legacy and non-averaged positions", () => {
    const missingConfig = postAverageStopLoss.evaluate({
      netPnlPercent: -100,
      netPnlUsdt: -100,
      position: createAveragedPosition(1),
    });
    const noAverage = postAverageStopLoss.evaluate({
      config: {
        enabled: true,
        thresholds: [
          { minAveragingCount: 1, maxNetPnlPct: -1, maxNetPnlUsdt: -1 },
        ],
      },
      netPnlPercent: -100,
      netPnlUsdt: -100,
      position: createAveragedPosition(0),
    });

    // BOTH:POST_AVERAGE_STOP_LOSS
    expect(missingConfig.shouldExit).toBe(false);
    expect(noAverage.shouldExit).toBe(false);
  });

  it.each([
    { currentPrice: 110, direction: "LONG" as const },
    { currentPrice: 90, direction: "SHORT" as const },
  ])(
    "requires favorable $direction distance for the rescue exit",
    ({ currentPrice, direction }) => {
      const result = postAverageRescue.evaluate({
        currentPrice,
        direction,
        lastVolatilityPrice: 100,
        netPnlPercent: 1,
        position: createAveragedPosition(1),
      });

      // BOTH:POST_AVERAGE_RESCUE_EXIT
      expect(result.shouldExit).toBe(true);
    },
  );

  it("keeps backtest open when the post-average rescue exit is disabled", () => {
    const exit = resolveBacktestExitDecision({
      position: createAveragedPosition(1) as any,
      currentPrice: 102,
      forceSell: false,
      globalLiquidation: false,
      hasReachedVolatilityTarget: false,
      lastVolatilityPrice: 90,
      modelConfig: {
        takeProfitPercent: 5,
        stopLossPercent: 10,
        postAverageRescueExit: {
          enabled: false,
          thresholds: [{ minAveragingCount: 1, minNetPnlPct: -100 }],
        },
      },
    });

    // BOTH:POST_AVERAGE_RESCUE_EXIT
    expect(exit.shouldExit).toBe(false);
  });

  it("applies the post-average percentage stop in backtest", () => {
    const exit = resolveBacktestExitDecision({
      position: createAveragedPosition(1) as any,
      currentPrice: 95,
      forceSell: false,
      globalLiquidation: false,
      hasReachedVolatilityTarget: false,
      lastVolatilityPrice: 90,
      modelConfig: {
        takeProfitPercent: 100,
        stopLossPercent: 90,
        stopLossUSDT: 0,
        postAverageRescueExit: { enabled: false, thresholds: [] },
        postAverageStopLoss: {
          enabled: true,
          thresholds: [
            { minAveragingCount: 1, maxNetPnlPct: -5, maxNetPnlUsdt: 0 },
          ],
        },
      },
    });

    // BOTH:POST_AVERAGE_STOP_LOSS
    expect(exit.shouldExit).toBe(true);
    expect(exit.category).toBe(TRADE_MESSAGE.sell.POST_AVERAGE_STOP_LOSS);
    expect(exit.message).toContain("pct");
  });

  it("back-thinks the first crossed loss boundary from a later vPoint rail", () => {
    const position = createAveragedPosition(2);
    position.exposure = {
      averageEntryPrice: 100,
      leverage: 5,
      marginUsdt: 79.6,
      notionalUsdt: 398,
      quantity: 3.98,
    };
    position.fees.entryUsdt = 0.398;
    const railPrice = 88.43;
    const railNetPnlUsdt = calculateBacktestFeeAdjustedNetProfitUSDT(
      position,
      railPrice,
      0.001,
    );
    const exit = resolveBacktestExitDecision({
      position,
      currentPrice: railPrice,
      exitFeeRatio: 0.001,
      forceSell: false,
      globalLiquidation: false,
      modelConfig: {
        takeProfitPercent: 100,
        stopLossPercent: 15,
        stopLossUSDT: 14,
        postAverageRescueExit: { enabled: false, thresholds: [] },
        postAverageStopLoss: {
          enabled: true,
          thresholds: [
            { minAveragingCount: 2, maxNetPnlPct: -2, maxNetPnlUsdt: 0 },
          ],
        },
      },
    });
    const exactNetPnlUsdt = calculateBacktestFeeAdjustedNetProfitUSDT(
      position,
      exit.exitPrice,
      0.001,
    );

    // BTEST:VPOINT_RAIL_BACKTHINK_LOSS_BOUNDARY
    // BOTH:POST_AVERAGE_STOP_LOSS
    expect(railNetPnlUsdt).toBeLessThan(-46);
    expect(exit.category).toBe(TRADE_MESSAGE.sell.POST_AVERAGE_STOP_LOSS);
    expect(exit.netProfitPercent).toBeCloseTo(-2);
    expect(exactNetPnlUsdt).toBeCloseTo(-7.96);
    expect(exit.message).toContain("boundary:pct");
    expect(exit.message).toContain("backthinkNetPnlUsdt:-7.96");
  });

  it("applies the post-average USDT stop in production", async () => {
    const memory = createRescueMemory(1);
    const exit = await dynamicExit({
      symbol: "SUI",
      current: buildKline(3, 94),
      config: {
        ...rescueExitConfig,
        stopLossUSDT: 0,
        postAverageRescueExit: { enabled: false, thresholds: [] },
        postAverageStopLoss: {
          enabled: true,
          thresholds: [
            { minAveragingCount: 1, maxNetPnlPct: 0, maxNetPnlUsdt: -5 },
          ],
        },
      },
      memory,
      exchangeType: "tokocrypto",
      tradingMode: TradingMode.SPOT,
    });

    // BOTH:POST_AVERAGE_STOP_LOSS
    expect(exit.action).toBe("SELL");
    expect(exit.category).toBe(TRADE_MESSAGE.sell.POST_AVERAGE_STOP_LOSS);
    expect(memory.positionsSell?.[0].closed?.reason).toBe(
      "POST_AVERAGE_STOP_LOSS",
    );
  });

  it("keeps the other production leg independent after a post-average stop", async () => {
    const main = createAveragedPosition(1);
    main.role = "MAIN";
    const counter = createTestPosition({
      direction: "SHORT",
      entryId: main.opened.vPoint.id,
      entryLevel: main.opened.vPoint.lvl,
      entryPrice: 100,
      entryTime: main.opened.t,
      notionalUsdt: 100,
      quantity: 1,
      role: "COUNTER",
      symbol: main.symbol,
      tradingMode: TradingMode.SPOT,
    });
    const memory = {
      ...createRescueMemory(1),
      positions: [main, counter],
    } as TradingModelMemory;
    const config: TradingModelConfig = {
      ...rescueExitConfig,
      stopLossUSDT: 0,
      postAverageRescueExit: { enabled: false, thresholds: [] },
      postAverageStopLoss: {
        enabled: true,
        thresholds: [
          { minAveragingCount: 1, maxNetPnlPct: -5, maxNetPnlUsdt: 0 },
        ],
      },
    };

    const mainExit = await dynamicExit({
      symbol: "SUI",
      current: buildKline(3, 94),
      config,
      memory,
      exchangeType: "tokocrypto",
      positionRole: "MAIN",
      tradingMode: TradingMode.SPOT,
    });
    const counterExit = await dynamicExit({
      symbol: "SUI",
      current: buildKline(3, 94),
      config,
      memory,
      exchangeType: "tokocrypto",
      positionRole: "COUNTER",
      tradingMode: TradingMode.SPOT,
    });

    // BOTH:POST_AVERAGE_STOP_LOSS
    // BOTH:INDEPENDENT_LEG_STOP_LOSS
    expect(mainExit.category).toBe(TRADE_MESSAGE.sell.POST_AVERAGE_STOP_LOSS);
    expect(counterExit.action).toBe("SELL");
    expect(memory.positionsSell?.map((position) => position.closed?.reason))
      .toEqual(["POST_AVERAGE_STOP_LOSS", "VOLATILITY_TARGET_EXIT"]);
  });

  it("applies custom post-average rescue thresholds in backtest", () => {
    const baseParams = {
      position: createAveragedPosition(1) as any,
      forceSell: false,
      globalLiquidation: false,
      hasReachedVolatilityTarget: false,
      lastVolatilityPrice: 90,
      modelConfig: {
        takeProfitPercent: 5,
        stopLossPercent: 10,
        postAverageRescueExit: {
          enabled: true,
          thresholds: [{ minAveragingCount: 1, minNetPnlPct: 2 }],
        },
      },
    };

    const belowCustomThreshold = resolveBacktestExitDecision({
      ...baseParams,
      currentPrice: 101,
    });
    const atCustomThreshold = resolveBacktestExitDecision({
      ...baseParams,
      currentPrice: 102.21,
    });

    // BOTH:POST_AVERAGE_RESCUE_EXIT
    expect(belowCustomThreshold.shouldExit).toBe(false);
    expect(atCustomThreshold.shouldExit).toBe(true);
    expect(atCustomThreshold.category).toBe(
      TRADE_MESSAGE.sell.POST_AVERAGE_RESCUE_EXIT,
    );
  });

  it("requires a valid latest-vPoint distance in every rescue tier", () => {
    const result = postAverageRescue.evaluate({
      currentPrice: 100,
      direction: "LONG",
      lastVolatilityPrice: undefined,
      netPnlPercent: 1,
      position: createAveragedPosition(3),
    });

    // BOTH:POST_AVERAGE_RESCUE_EXIT
    expect(result.shouldExit).toBe(false);
  });

  it.each([
    { count: 1, currentPrice: 100.4 },
    { count: 2, currentPrice: 100.19 },
    { count: 3, currentPrice: 99.69 },
  ])(
    "keeps backtest open below the rescue tier after $count averaging executions",
    ({ count, currentPrice }) => {
      const exit = resolveBacktestExitDecision({
        position: createAveragedPosition(count) as any,
        currentPrice,
        forceSell: false,
        globalLiquidation: false,
        hasReachedVolatilityTarget: false,
        lastVolatilityPrice: 90,
        modelConfig: {
          takeProfitPercent: 5,
          stopLossPercent: 10,
        },
      });

      // BOTH:POST_AVERAGE_RESCUE_EXIT
      expect(exit.shouldExit).toBe(false);
    },
  );

  it("keeps production open when the post-average rescue exit is disabled", async () => {
    const memory = createRescueMemory(1);

    const exit = await dynamicExit({
      symbol: "SUI",
      current: buildKline(3, 102),
      config: {
        ...rescueExitConfig,
        postAverageRescueExit: {
          enabled: false,
          thresholds: [{ minAveragingCount: 1, minNetPnlPct: -100 }],
        },
      },
      memory,
      exchangeType: "tokocrypto",
      tradingMode: TradingMode.SPOT,
    });

    // BOTH:POST_AVERAGE_RESCUE_EXIT
    expect(exit.action).toBe("HOLD");
    expect(memory.positions).toHaveLength(1);
    expect(memory.positionsSell).toHaveLength(0);
  });

  it("applies custom post-average rescue thresholds in production", async () => {
    const config: TradingModelConfig = {
      ...rescueExitConfig,
      postAverageRescueExit: {
        enabled: true,
        thresholds: [{ minAveragingCount: 1, minNetPnlPct: 2 }],
      },
    };
    const belowThresholdMemory = createRescueMemory(1);
    const atThresholdMemory = createRescueMemory(1);

    const belowCustomThreshold = await dynamicExit({
      symbol: "SUI",
      current: buildKline(3, 101),
      config,
      memory: belowThresholdMemory,
      exchangeType: "tokocrypto",
      tradingMode: TradingMode.SPOT,
    });
    const atCustomThreshold = await dynamicExit({
      symbol: "SUI",
      current: buildKline(3, 102),
      config,
      memory: atThresholdMemory,
      exchangeType: "tokocrypto",
      tradingMode: TradingMode.SPOT,
    });

    // BOTH:POST_AVERAGE_RESCUE_EXIT
    expect(belowCustomThreshold.action).toBe("HOLD");
    expect(atCustomThreshold.action).toBe("SELL");
    expect(atCustomThreshold.category).toBe(
      TRADE_MESSAGE.sell.POST_AVERAGE_RESCUE_EXIT,
    );
  });

  it.each([
    { count: 1, currentPrice: 101.21, expectedNetPnl: 1.01 },
    { count: 2, currentPrice: 100.21, expectedNetPnl: 0.01 },
    { count: 3, currentPrice: 99.71, expectedNetPnl: -0.49 },
  ])(
    "exits backtest through the rescue tier after $count averaging executions",
    ({ count, currentPrice, expectedNetPnl }) => {
      const exit = resolveBacktestExitDecision({
        position: createAveragedPosition(count) as any,
        currentPrice,
        forceSell: false,
        globalLiquidation: false,
        hasReachedVolatilityTarget: false,
        lastVolatilityPrice: 90,
        modelConfig: {
          takeProfitPercent: 5,
          stopLossPercent: 10,
        },
      });

      // BOTH:POST_AVERAGE_RESCUE_EXIT
      expect(exit.shouldExit).toBe(true);
      expect(exit.category).toBe(TRADE_MESSAGE.sell.POST_AVERAGE_RESCUE_EXIT);
      expect(exit.netProfitPercent).toBeCloseTo(expectedNetPnl);
      expect(exit.message).toContain("BOTH:POST_AVERAGE_RESCUE_EXIT");
    },
  );

  it.each([
    { count: 1, currentPrice: 100.49 },
    { count: 2, currentPrice: 99.99 },
    { count: 3, currentPrice: 99.49 },
  ])(
    "keeps production open below the rescue tier after $count averaging executions",
    async ({ count, currentPrice }) => {
      const memory = createRescueMemory(count);

      const exit = await dynamicExit({
        symbol: "SUI",
        current: buildKline(3, currentPrice),
        config: rescueExitConfig,
        memory,
        exchangeType: "tokocrypto",
        tradingMode: TradingMode.SPOT,
      });

      // BOTH:POST_AVERAGE_RESCUE_EXIT
      expect(exit.action).toBe("HOLD");
      expect(memory.positions).toHaveLength(1);
      expect(memory.positionsSell).toHaveLength(0);
    },
  );

  it("does not bypass normal backtest TP for a non-averaged low-TP position", () => {
    const exit = resolveBacktestExitDecision({
      position: createPosition() as any,
      currentPrice: 100.5,
      forceSell: false,
      globalLiquidation: false,
      hasReachedVolatilityTarget: false,
      lastVolatilityPrice: 95,
      modelConfig: {
        takeProfitPercent: 3,
        stopLossPercent: 90,
      },
    });

    // BOTH:TRADITIONAL_TP_SL
    expect(exit.shouldExit).toBe(false);
  });

  it("supports production SL Plus trailing profit protection", async () => {
    const memory = createMemory();
    const config: TradingModelConfig = {
      takeProfitPercent: 5,
      stopLossPercent: 90,
      useStopLossPlus: true,
      stopLossPlusTrigger: 1,
      orderType: "taker",
    };

    const activation = await dynamicExit({
      symbol: "SUI",
      current: buildKline(2, 107),
      config,
      memory,
      exchangeType: "tokocrypto",
      tradingMode: TradingMode.SPOT,
    });
    expect(activation.action).toBe("HOLD");

    const trailingExit = await dynamicExit({
      symbol: "SUI",
      current: buildKline(3, 104.9),
      config,
      memory,
      exchangeType: "tokocrypto",
      tradingMode: TradingMode.SPOT,
    });

    // PROD:SL_PLUS
    expect(trailingExit.action).toBe("SELL");
    expect(trailingExit.category).toBe(TRADE_MESSAGE.sell.SL_PLUS);
    expect(trailingExit.profit).toBeLessThan(0.05);
  });

  it("does not bypass production SL Plus before its activation threshold", async () => {
    const memory = createMemory();
    memory.volatility = {
      symbol: "SUI",
      lastVolatility: [
        {
          id: "BOTTOM[-3]",
          l: "B",
          lvl: -3,
          pct: 5,
          p: 90,
          t: 2,
          vb: 1,
          vq: 90,
        },
      ],
    };
    const config: TradingModelConfig = {
      takeProfitPercent: 3,
      stopLossPercent: 90,
      useStopLossPlus: true,
      stopLossPlusTrigger: 1,
      orderType: "taker",
    };

    const exit = await dynamicExit({
      symbol: "SUI",
      current: buildKline(3, 100.5),
      config,
      memory,
      exchangeType: "tokocrypto",
      tradingMode: TradingMode.SPOT,
    });

    // PROD:SL_PLUS
    expect(exit.action).toBe("HOLD");
    expect(memory.positions).toHaveLength(1);
  });

  it("records the custom force-sell reason in production exit messages", async () => {
    const memory = createMemory();
    memory.volatility = {
      symbol: "SUI",
      lastVolatility: [
        {
          id: "B_TEST",
          l: "B",
          lvl: -2,
          pct: 5,
          p: 100,
          t: 0,
          vb: 1,
          vq: 100,
        },
        {
          id: "B_NOT_AVERAGED",
          l: "B",
          lvl: -3,
          pct: 5,
          p: 95,
          t: 1,
          vb: 1,
          vq: 95,
        },
        {
          id: "T_EXIT",
          l: "T",
          lvl: 0,
          pct: 5,
          p: 100,
          t: 2,
          vb: 1,
          vq: 100,
        },
      ],
    };
    memory.positions[0].control = {
      forceExit: {
        reason: "BOTH:EXIT_SIDEWAYS_TO_ENTRY_STRONG_CANDIDATES | free worker",
      },
    };
    const config: TradingModelConfig = {
      takeProfitPercent: 5,
      stopLossPercent: 90,
      orderType: "taker",
    };

    const exit = await dynamicExit({
      symbol: "SUI",
      current: buildKline(2, 100),
      config,
      memory,
      exchangeType: "tokocrypto",
      tradingMode: TradingMode.SPOT,
    });

    // BOTH:EXIT_SIDEWAYS_TO_ENTRY_STRONG_CANDIDATES
    expect(exit.action).toBe("SELL");
    expect(exit.reason).toContain(
      "BOTH:EXIT_SIDEWAYS_TO_ENTRY_STRONG_CANDIDATES",
    );
    expect(memory.positionsSell?.[0].closed?.message).toBe(exit.reason);
    // BOTH:POSITION_VPOINT_PATH
    expect(memory.positionsSell?.[0].vPoints).toEqual([
      { id: "B_NOT_AVERAGED", lvl: -3 },
    ]);
  });

  it.each([
    { count: 1, currentPrice: 101, expectedProfit: 0.01 },
    { count: 2, currentPrice: 100.01, expectedProfit: 0.0001 },
    { count: 3, currentPrice: 99.5, expectedProfit: -0.005 },
  ])(
    "exits production through the rescue tier after $count averaging executions",
    async ({ count, currentPrice, expectedProfit }) => {
      const memory = createRescueMemory(count);

      const exit = await dynamicExit({
        symbol: "SUI",
        current: buildKline(3, currentPrice),
        config: rescueExitConfig,
        memory,
        exchangeType: "tokocrypto",
        tradingMode: TradingMode.SPOT,
      });

      // BOTH:POST_AVERAGE_RESCUE_EXIT
      expect(exit.action).toBe("SELL");
      expect(exit.category).toBe(TRADE_MESSAGE.sell.POST_AVERAGE_RESCUE_EXIT);
      expect(exit.profit).toBeCloseTo(expectedProfit);
      expect(memory.positionsSell?.[0].closed?.reason).toBe(
        "POST_AVERAGE_RESCUE_EXIT",
      );
    },
  );

  it("uses the fee-inclusive production net PnL without deducting fees twice", async () => {
    exchangeMocks.getBothSideFeePercent.mockReturnValueOnce(0.2);
    const memory = createRescueMemory(1);

    const exit = await dynamicExit({
      symbol: "SUI",
      current: buildKline(3, 101.2),
      config: rescueExitConfig,
      memory,
      exchangeType: "tokocrypto",
      tradingMode: TradingMode.SPOT,
    });

    // BOTH:POST_AVERAGE_RESCUE_EXIT
    expect(exit.action).toBe("SELL");
    expect(exit.profit).toBeCloseTo(0.01);
    expect(memory.positionsSell?.[0].pnl.netPct).toBeCloseTo(1);
  });
});
