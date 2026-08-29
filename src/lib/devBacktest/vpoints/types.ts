export type VPointTunerRange = "6month" | "1year" | "2year";

export interface VPointTunerCombination {
  reversalThreshold: number;
  vpointsThreshold: number;
}

export interface VPointTunerPreparedKlines {
  cached: boolean;
  candleCount: number;
  interval: "5m";
  preparedAt: number;
  range: VPointTunerRange;
  symbol: string;
  t0: number;
  t1: number;
}

export type VPointTunerChartCandle = [
  t: number,
  o: number,
  h: number,
  l: number,
  c: number,
  v: number,
];

export interface VPointTunerChartKlines {
  candles: VPointTunerChartCandle[];
  interval: "5m";
  range: VPointTunerRange;
  symbol: string;
}

export interface VPointTunerPoint {
  l: "T" | "B";
  lvl: number;
  p: number;
  pct: number;
  t: number;
}

export interface VPointTunerSeries {
  averageGapMs: number | null;
  combinationIndex: number;
  maxAbsLevel: number;
  pointCount: number;
  points: VPointTunerPoint[];
}

export interface VPointTunerAnalysis {
  candleCount: number;
  range: VPointTunerRange;
  series: VPointTunerSeries[];
  symbol: string;
  t0: number;
  t1: number;
}
