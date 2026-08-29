import type { Kline } from "@/lib/exchange/platform/tokocrypto";
import { afterEach, describe, expect, it, vi } from "vitest";

function kline(index: number, close: number): Kline {
  const t = Date.UTC(2026, 0, 1, 0, index * 5);
  return [
    t,
    String(close),
    String(close),
    String(close),
    String(close),
    "1",
    t + 5 * 60_000 - 1,
    "1",
    1,
    "1",
    "1",
    "0",
    "0",
  ];
}

async function detectWithConfiguredReversal(value: string) {
  vi.stubEnv("VOLATILITY_REVERSAL_THRESHOLD", value);
  vi.resetModules();
  const { detectVolatilityPoints } = await import("@/lib/dynamic");
  return detectVolatilityPoints({
    klines: [kline(0, 100), kline(1, 103), kline(2, 102.4)],
    moveThreshold: 2,
    symbol: "TEST",
  });
}

describe.sequential("production volatility reversal environment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults to a one-percent confirmation reversal when undefined", async () => {
    const points = await detectWithConfiguredReversal("");

    // PROD:GLOBAL_VOLATILITY_REVERSAL_THRESHOLD
    expect(points).toHaveLength(0);
  });

  it("uses a fractional configured confirmation reversal", async () => {
    const points = await detectWithConfiguredReversal("0.5");

    // PROD:GLOBAL_VOLATILITY_REVERSAL_THRESHOLD
    expect(points).toMatchObject([{ l: "T", p: 103 }]);
  });
});
