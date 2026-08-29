import { fetchKlinesFunction } from "@/lib/datasets/fetchKlines";
import { detectVolatilityPoints } from "@/lib/dynamic";
import type { Kline } from "@/lib/exchange/platform/tokocrypto";
import {
  resolveLocalProjectRoot,
  resolvePersistentStorageRoot,
} from "@/lib/persistent-storage-root";
import fs from "fs-extra";
import path from "path";
import type {
  VPointTunerAnalysis,
  VPointTunerChartKlines,
  VPointTunerCombination,
  VPointTunerPreparedKlines,
  VPointTunerRange,
  VPointTunerSeries,
} from "./types";

const INTERVAL = "5m" as const;
const EXCHANGE = "binance" as const;
const MARKET_TYPE = "FUTURES" as const;
const CACHE_VERSION = 1;
const MAX_COMBINATIONS = 10;
const MAX_SYMBOLS = 12;
const RANGES = ["6month", "1year", "2year"] as const;

interface CacheMetadata extends Omit<VPointTunerPreparedKlines, "cached"> {
  exchange: typeof EXCHANGE;
  marketType: typeof MARKET_TYPE;
  version: typeof CACHE_VERSION;
}

function normalizeSymbol(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/_?USDT$/, "");
}

function parseSymbols(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : String(value ?? "").split(/[\s,]+/);
  const symbols = [
    ...new Set(values.map(normalizeSymbol).filter((symbol) => symbol.length > 0)),
  ];

  if (symbols.length === 0) {
    throw new Error("Enter at least one symbol");
  }
  if (symbols.length > MAX_SYMBOLS) {
    throw new Error(`Use at most ${MAX_SYMBOLS} symbols at once`);
  }

  const invalid = symbols.find((symbol) => !/^[A-Z0-9]{1,20}$/.test(symbol));
  if (invalid) {
    throw new Error(`Invalid symbol: ${invalid}`);
  }

  return symbols;
}

function parseRange(value: unknown): VPointTunerRange {
  const range = String(value ?? "");
  if (!(RANGES as readonly string[]).includes(range)) {
    throw new Error("Range must be 6 months, 1 year, or 2 years");
  }
  return range as VPointTunerRange;
}

function parseThreshold(value: unknown, label: string): number {
  const threshold = Number(value);
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 100) {
    throw new Error(`${label} must be greater than 0 and at most 100`);
  }
  return threshold;
}

function parseCombinations(value: unknown): VPointTunerCombination[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Add at least one threshold combination");
  }
  if (value.length > MAX_COMBINATIONS) {
    throw new Error(`Use at most ${MAX_COMBINATIONS} combinations at once`);
  }

  const combinations = value.map((item, index) => {
    const record = item && typeof item === "object" ? item : {};
    return {
      reversalThreshold: parseThreshold(
        (record as Record<string, unknown>).reversalThreshold,
        `Combination ${index + 1} reversal threshold`,
      ),
      vpointsThreshold: parseThreshold(
        (record as Record<string, unknown>).vpointsThreshold,
        `Combination ${index + 1} vPoint threshold`,
      ),
    };
  });

  const keys = combinations.map(
    (combination) =>
      `${combination.vpointsThreshold}:${combination.reversalThreshold}`,
  );
  if (new Set(keys).size !== keys.length) {
    throw new Error("Remove duplicate threshold combinations");
  }

  return combinations;
}

function getCachePaths(range: VPointTunerRange, symbol: string) {
  const folder = path.join(
    resolveLocalProjectRoot(),
    "storage",
    "cache",
    "dev",
    "vpoint-tuner",
    "klines",
    EXCHANGE,
    MARKET_TYPE.toLowerCase(),
    `${range}_${INTERVAL}`,
  );
  return {
    data: path.join(folder, `${symbol}.json`),
    metadata: path.join(folder, ".meta", `${symbol}.json`),
  };
}

function getLegacyCachePaths(range: VPointTunerRange, symbol: string) {
  const folder = path.join(
    resolvePersistentStorageRoot(),
    "dev",
    "vpoint-tuner",
    "klines",
    EXCHANGE,
    MARKET_TYPE.toLowerCase(),
    `${range}_${INTERVAL}`,
  );
  return {
    data: path.join(folder, `${symbol}.json`),
    metadata: path.join(folder, ".meta", `${symbol}.json`),
  };
}

/** Moves a complete legacy per-instance tuner cache into dev cache storage. */
async function migrateLegacyCache(range: VPointTunerRange, symbol: string) {
  const paths = getCachePaths(range, symbol);
  if ((await fs.pathExists(paths.data)) && (await fs.pathExists(paths.metadata))) {
    return;
  }

  const legacyPaths = getLegacyCachePaths(range, symbol);
  if (
    !(await fs.pathExists(legacyPaths.data)) ||
    !(await fs.pathExists(legacyPaths.metadata))
  ) {
    return;
  }

  await fs.ensureDir(path.dirname(paths.data));
  await fs.ensureDir(path.dirname(paths.metadata));
  await fs.copy(legacyPaths.data, paths.data, {
    errorOnExist: false,
    overwrite: false,
  });
  await fs.copy(legacyPaths.metadata, paths.metadata, {
    errorOnExist: false,
    overwrite: false,
  });

  if ((await fs.pathExists(paths.data)) && (await fs.pathExists(paths.metadata))) {
    await Promise.all([
      fs.remove(legacyPaths.data),
      fs.remove(legacyPaths.metadata),
    ]);
  }
}

async function readCompatibleMetadata(
  range: VPointTunerRange,
  symbol: string,
): Promise<CacheMetadata | null> {
  await migrateLegacyCache(range, symbol);
  const paths = getCachePaths(range, symbol);
  if (!(await fs.pathExists(paths.data)) || !(await fs.pathExists(paths.metadata))) {
    return null;
  }

  try {
    const metadata = (await fs.readJson(paths.metadata)) as CacheMetadata;
    if (
      metadata.version !== CACHE_VERSION ||
      metadata.exchange !== EXCHANGE ||
      metadata.marketType !== MARKET_TYPE ||
      metadata.interval !== INTERVAL ||
      metadata.range !== range ||
      metadata.symbol !== symbol
    ) {
      return null;
    }
    return metadata;
  } catch {
    return null;
  }
}

/** Calculates the average time between consecutive volatility points. */
function averagePointGapMs(points: Array<{ t: number }>): number | null {
  if (points.length < 2) return null;
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += points[index].t - points[index - 1].t;
  }
  return total / (points.length - 1);
}

/** Runs every threshold combination against one shared kline dataset. */
function analyzeKlines(params: {
  combinations: VPointTunerCombination[];
  klines: Kline[];
  range: VPointTunerRange;
  symbol: string;
}): VPointTunerAnalysis {
  const series: VPointTunerSeries[] = params.combinations.map(
    (combination, combinationIndex) => {
      const points = detectVolatilityPoints({
        klines: params.klines,
        moveThreshold: combination.vpointsThreshold,
        stopLossPercent: combination.reversalThreshold,
        symbol: params.symbol,
      });
      return {
        averageGapMs: averagePointGapMs(points),
        combinationIndex,
        maxAbsLevel: points.reduce(
          (maximum, point) => Math.max(maximum, Math.abs(point.lvl)),
          0,
        ),
        pointCount: points.length,
        points: points.map((point) => ({
          l: point.l,
          lvl: point.lvl,
          p: point.p,
          pct: point.pct,
          t: point.t,
        })),
      };
    },
  );

  return {
    candleCount: params.klines.length,
    range: params.range,
    series,
    symbol: params.symbol,
    t0: params.klines[0]?.[0] ?? 0,
    t1: params.klines.at(-1)?.[0] ?? 0,
  };
}

async function prepareKlines(params: {
  range: VPointTunerRange;
  symbol: string;
}): Promise<VPointTunerPreparedKlines> {
  const cached = await readCompatibleMetadata(params.range, params.symbol);
  if (cached) {
    return { ...cached, cached: true };
  }

  const klines = await fetchKlinesFunction({
    exchangeType: EXCHANGE,
    exchangeTypeForce: true,
    interval: INTERVAL,
    marketType: MARKET_TYPE,
    saveToFile: false,
    simpleTime: params.range,
    symbol: `${params.symbol}_USDT`,
    useCache: false,
    verbose: true,
  });
  if (klines.length === 0) {
    throw new Error(`No Binance USDT Futures klines found for ${params.symbol}`);
  }

  const paths = getCachePaths(params.range, params.symbol);
  const metadata: CacheMetadata = {
    candleCount: klines.length,
    exchange: EXCHANGE,
    interval: INTERVAL,
    marketType: MARKET_TYPE,
    preparedAt: Date.now(),
    range: params.range,
    symbol: params.symbol,
    t0: klines[0][0],
    t1: klines.at(-1)![0],
    version: CACHE_VERSION,
  };
  await fs.ensureDir(path.dirname(paths.data));
  await fs.writeJson(paths.data, klines);
  await fs.ensureDir(path.dirname(paths.metadata));
  await fs.writeJson(paths.metadata, metadata);

  return { ...metadata, cached: false };
}

async function runAnalysis(params: {
  combinations: VPointTunerCombination[];
  range: VPointTunerRange;
  symbol: string;
}): Promise<VPointTunerAnalysis> {
  const klines = await readPreparedKlines(params);
  return analyzeKlines({ ...params, klines });
}

async function readPreparedKlines(params: {
  range: VPointTunerRange;
  symbol: string;
}): Promise<Kline[]> {
  if (!(await readCompatibleMetadata(params.range, params.symbol))) {
    throw new Error(`Prepare ${params.symbol} klines before comparing thresholds`);
  }
  const paths = getCachePaths(params.range, params.symbol);
  return (await fs.readJson(paths.data)) as Kline[];
}

/** Compacts OHLCV candles for the on-demand browser chart. */
function compactChartKlines(params: {
  klines: Kline[];
  range: VPointTunerRange;
  symbol: string;
}): VPointTunerChartKlines {
  return {
    candles: params.klines.map((kline) => [
      kline[0],
      Number(kline[1]),
      Number(kline[2]),
      Number(kline[3]),
      Number(kline[4]),
      Number(kline[5]),
    ]),
    interval: INTERVAL,
    range: params.range,
    symbol: params.symbol,
  };
}

/** Reads prepared candles from dev storage and compacts them for charting. */
async function loadChartKlines(params: {
  range: VPointTunerRange;
  symbol: string;
}): Promise<VPointTunerChartKlines> {
  const klines = await readPreparedKlines(params);
  return compactChartKlines({ ...params, klines });
}

const vpointTuner = {
  analysis: {
    fromKlines: analyzeKlines,
    run: runAnalysis,
  },
  cache: {
    paths: {
      get: getCachePaths,
    },
  },
  input: {
    combinations: {
      parse: parseCombinations,
    },
    range: {
      parse: parseRange,
      values: RANGES,
    },
    symbols: {
      parse: parseSymbols,
    },
  },
  klines: {
    chart: {
      fromKlines: compactChartKlines,
      load: loadChartKlines,
    },
    prepare: prepareKlines,
  },
  limits: {
    combinations: MAX_COMBINATIONS,
    symbols: MAX_SYMBOLS,
  },
};

export default vpointTuner;
export type * from "./types";
