"use client";

import type { LeveledMarkers } from "@/components/LiveDashboard/converter";
import MultiLineTimelined from "@/components/ui/Chart/MultiLineTimelined";
import type {
  VPointTunerAnalysis,
  VPointTunerCombination,
} from "@/lib/devBacktest/vpoints";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import { useMemo } from "react";
import { VPOINT_TUNER_COLORS } from "./CombinationEditor";
import CoinVPointPctSummary from "./CoinVPointPctSummary";
import VPointKlinesDialog from "./VPointKlinesDialog";

const CHART_INITIAL_DIMENSION = { height: 430, width: 800 };

function formatDuration(ms: number | null) {
  if (ms === null) return "—";
  const minutes = ms / 60_000;
  if (minutes < 60) return `${minutes.toFixed(0)}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

export default function CoinVPointsChart({
  analysis,
  combinations,
}: {
  analysis: VPointTunerAnalysis;
  combinations: VPointTunerCombination[];
}) {
  const chart = useMemo(() => {
    const series: LeveledMarkers[][] = analysis.series.map((item) => {
      const combination = combinations[item.combinationIndex];
      const color =
        VPOINT_TUNER_COLORS[
          item.combinationIndex % VPOINT_TUNER_COLORS.length
        ];
      return item.points.map((point) => ({
        color,
        level: point.lvl,
        text: `${analysis.symbol} ${point.l} [${point.lvl}] · ${point.pct}% @ ${point.p} · vPoint ${combination.vpointsThreshold}% / reversal ${combination.reversalThreshold}%`,
        time: Math.floor(point.t / 1000),
      }));
    });
    const names = analysis.series.map((item) => {
      const combination = combinations[item.combinationIndex];
      return `#${item.combinationIndex + 1} · ${combination.vpointsThreshold}% / ${combination.reversalThreshold}%`;
    });
    return { names, series };
  }, [analysis, combinations]);

  return (
    <Paper
      component="section"
      variant="outlined"
      sx={{ minWidth: 0, overflow: "hidden" }}
    >
      <Box
        sx={{
          alignItems: { sm: "center" },
          borderBottom: 1,
          borderColor: "divider",
          display: "flex",
          flexDirection: { xs: "column", sm: "row" },
          gap: 1,
          justifyContent: "space-between",
          px: { xs: 1.5, md: 2 },
          py: 1.5,
        }}
      >
        <Box>
          <Typography component="h2" fontWeight={800} variant="h6">
            {analysis.symbol}
          </Typography>
          <Typography color="text.secondary" variant="caption">
            {analysis.candleCount.toLocaleString()} five-minute candles · {" "}
            {new Date(analysis.t0).toLocaleDateString()} – {" "}
            {new Date(analysis.t1).toLocaleDateString()}
          </Typography>
        </Box>
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>
          {analysis.series.map((item) => {
            const combination = combinations[item.combinationIndex];
            const color =
              VPOINT_TUNER_COLORS[
                item.combinationIndex % VPOINT_TUNER_COLORS.length
              ];
            const label = `#${item.combinationIndex + 1}: ${item.pointCount.toLocaleString()} pts · |L|max ${item.maxAbsLevel} · gap ${formatDuration(item.averageGapMs)}`;
            return (
              <VPointKlinesDialog
                color={color}
                combination={combination}
                combinationIndex={item.combinationIndex}
                key={item.combinationIndex}
                label={label}
                points={item.points}
                range={analysis.range}
                symbol={analysis.symbol}
              />
            );
          })}
        </Box>
      </Box>
      <Box sx={{ minHeight: 0, minWidth: 0, px: { xs: 0.5, md: 1.5 }, pb: 1 }}>
        <MultiLineTimelined
          colors={[...VPOINT_TUNER_COLORS]}
          height={430}
          initialDimension={CHART_INITIAL_DIMENSION}
          names={chart.names}
          series={chart.series}
        />
      </Box>
      <Box
        sx={{
          borderTop: 1,
          borderColor: "divider",
          display: "grid",
          gap: 1.5,
          gridTemplateColumns: {
            xs: "minmax(0, 1fr)",
            md: "repeat(2, minmax(0, 1fr))",
            xl: "repeat(5, minmax(0, 1fr))",
          },
          p: { xs: 1, md: 1.5 },
        }}
      >
        {analysis.series.map((series) => (
          <CoinVPointPctSummary
            color={
              VPOINT_TUNER_COLORS[
                series.combinationIndex % VPOINT_TUNER_COLORS.length
              ]
            }
            combination={combinations[series.combinationIndex]}
            key={series.combinationIndex}
            range={analysis.range}
            series={series}
          />
        ))}
      </Box>
    </Paper>
  );
}
