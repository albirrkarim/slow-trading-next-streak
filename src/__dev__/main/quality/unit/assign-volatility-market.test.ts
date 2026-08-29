import {
  assignVolatility,
  pruneVolatilityPoints,
} from "@/components/api/production/utils";
import type { VolatilityPoint } from "@/lib/dynamic";
import { TradingMode } from "@/lib/exchange";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exists: vi.fn(async () => false),
  predictionEngine: vi.fn(async ({ memory }) => memory),
}));

vi.mock("@/lib/dynamic", () => ({
  predictionEngine: mocks.predictionEngine,
}));

vi.mock("fs-extra", () => ({
  default: {
    exists: mocks.exists,
    readJSON: vi.fn(),
  },
}));

describe("production volatility market", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes the configured futures market to the prediction engine", async () => {
    await assignVolatility({}, ["AKT"], "binance", TradingMode.FUTURES, 1);

    // PROD:INITIALIZE_MARKET_TYPE
    expect(mocks.predictionEngine).toHaveBeenCalledWith(
      expect.objectContaining({
        exchangeType: "binance",
        marketType: "FUTURES",
        minAbsLevelToEntry: 1,
        tradePair: "AKT_USDT",
      }),
    );
  });

  it("retains the arming path through the target for an active position", () => {
    const points = [
      { id: "ENTRY-L0", l: "B", lvl: 0, p: 100, pct: 1, t: 10, vb: 1, vq: 1 },
      { id: "ARM-L1", l: "T", lvl: 1, p: 105, pct: 5, t: 20, vb: 1, vq: 1 },
      { id: "TARGET-L0", l: "B", lvl: 0, p: 100, pct: 5, t: 30, vb: 1, vq: 1 },
      { id: "LATER-L1", l: "T", lvl: 1, p: 101, pct: 1, t: 40, vb: 1, vq: 1 },
    ] satisfies VolatilityPoint[];

    expect(pruneVolatilityPoints(points, 15).map((point) => point.id)).toEqual([
      "ARM-L1",
      "TARGET-L0",
      "LATER-L1",
    ]);
  });
});
