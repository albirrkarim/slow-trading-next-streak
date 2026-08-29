import vpointTuner, {
  type VPointTunerCombination,
} from "@/lib/devBacktest/vpoints";
import type { Kline } from "@/lib/exchange/platform/tokocrypto";
import { resolvePersistentStorageRoot } from "@/lib/persistent-storage-root";
import fs from "fs-extra";
import path from "path";
import { describe, expect, it } from "vitest";

function kline(index: number, close: number): Kline {
  const time = Date.UTC(2026, 0, 1, 0, index * 5);
  return [
    time,
    String(close),
    String(close),
    String(close),
    String(close),
    "1",
    time + 5 * 60_000 - 1,
    "1",
    1,
    "1",
    "1",
    "0",
    "0",
  ];
}

describe("vPoint tuner inputs", () => {
  it("normalizes and deduplicates symbols", () => {
    expect(
      vpointTuner.input.symbols.parse("btc, ETH_USDT btcusdt  sol "),
    ).toEqual(["BTC", "ETH", "SOL"]);
  });

  it("accepts only the supported tuning ranges", () => {
    expect(vpointTuner.input.range.parse("6month")).toBe("6month");
    expect(vpointTuner.input.range.parse("1year")).toBe("1year");
    expect(vpointTuner.input.range.parse("2year")).toBe("2year");
    expect(() => vpointTuner.input.range.parse("5year")).toThrow(
      "Range must be 6 months, 1 year, or 2 years",
    );
  });

  it("validates and rejects duplicate combinations", () => {
    const combinations = vpointTuner.input.combinations.parse([
      { reversalThreshold: 0.75, vpointsThreshold: 2.5 },
    ]);
    expect(combinations).toEqual([
      { reversalThreshold: 0.75, vpointsThreshold: 2.5 },
    ]);
    expect(() =>
      vpointTuner.input.combinations.parse([
        { reversalThreshold: 1, vpointsThreshold: 2 },
        { reversalThreshold: 1, vpointsThreshold: 2 },
      ]),
    ).toThrow("Remove duplicate threshold combinations");
  });
});

describe("vPoint tuner analysis", () => {
  it("runs every combination over the same candle dataset", () => {
    const klines = [
      kline(0, 100),
      kline(1, 103),
      kline(2, 101.8),
      kline(3, 100),
      kline(4, 101.2),
    ];
    const combinations: VPointTunerCombination[] = [
      { reversalThreshold: 1, vpointsThreshold: 2 },
      { reversalThreshold: 1, vpointsThreshold: 5 },
    ];

    const result = vpointTuner.analysis.fromKlines({
      combinations,
      klines,
      range: "6month",
      symbol: "TEST",
    });

    expect(result.candleCount).toBe(klines.length);
    expect(result.series).toHaveLength(2);
    expect(result.series[0].combinationIndex).toBe(0);
    expect(result.series[0].points).toMatchObject([
      { l: "T", lvl: 1, p: 103, pct: 3 },
      { l: "B", lvl: 0, p: 100, pct: 2.91 },
    ]);
    expect(result.series[1]).toMatchObject({
      combinationIndex: 1,
      maxAbsLevel: 0,
      pointCount: 0,
      points: [],
    });
  });

  it("compacts chart candles to numeric OHLCV tuples", () => {
    const chart = vpointTuner.klines.chart.fromKlines({
      klines: [kline(0, 100)],
      range: "6month",
      symbol: "TEST",
    });

    expect(chart).toMatchObject({ interval: "5m", symbol: "TEST" });
    expect(chart.candles[0]).toHaveLength(6);
    expect(chart.candles[0].every(Number.isFinite)).toBe(true);
  });

  it("keeps tuner cache paths inside the isolated dev folder", () => {
    const paths = vpointTuner.cache.paths.get("2year", "BTC");
    expect(paths.data).toContain("/storage/cache/dev/vpoint-tuner/klines/");
    expect(paths.data).not.toContain("/storage/persistent/instances/");
    expect(paths.data).toContain("/2year_5m/BTC.json");
    expect(paths.metadata).toContain("/2year_5m/.meta/BTC.json");
  });

  it("migrates a complete legacy per-instance cache on first read", async () => {
    const symbol = `MIGRATE${process.pid}`;
    const range = "6month" as const;
    const paths = vpointTuner.cache.paths.get(range, symbol);
    const legacyFolder = path.join(
      resolvePersistentStorageRoot(),
      "dev",
      "vpoint-tuner",
      "klines",
      "binance",
      "futures",
      `${range}_5m`,
    );
    const legacyData = path.join(legacyFolder, `${symbol}.json`);
    const legacyMetadata = path.join(legacyFolder, ".meta", `${symbol}.json`);

    try {
      await fs.ensureDir(path.dirname(legacyData));
      await fs.ensureDir(path.dirname(legacyMetadata));
      await fs.writeJson(legacyData, [kline(0, 100)]);
      await fs.writeJson(legacyMetadata, {
        candleCount: 1,
        exchange: "binance",
        interval: "5m",
        marketType: "FUTURES",
        preparedAt: 1,
        range,
        symbol,
        t0: kline(0, 100)[0],
        t1: kline(0, 100)[0],
        version: 1,
      });

      const chart = await vpointTuner.klines.chart.load({ range, symbol });

      expect(chart.candles).toHaveLength(1);
      expect(await fs.pathExists(paths.data)).toBe(true);
      expect(await fs.pathExists(paths.metadata)).toBe(true);
      expect(await fs.pathExists(legacyData)).toBe(false);
      expect(await fs.pathExists(legacyMetadata)).toBe(false);
    } finally {
      await Promise.all([
        fs.remove(paths.data),
        fs.remove(paths.metadata),
        fs.remove(legacyData),
        fs.remove(legacyMetadata),
      ]);
    }
  });
});
