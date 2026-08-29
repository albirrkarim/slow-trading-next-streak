"use client";

import { VPointsSummary } from "@/components/LiveDashboard/Feature/VPointsFrequency";
import type {
  VPointTunerCombination,
  VPointTunerRange,
  VPointTunerSeries,
} from "@/lib/devBacktest/vpoints";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";

function formatRange(range: VPointTunerRange) {
  if (range === "6month") return "6month";
  if (range === "1year") return "1year";
  return "2year";
}

export default function CoinVPointPctSummary({
  color,
  combination,
  range,
  series,
}: {
  color: string;
  combination: VPointTunerCombination;
  range: VPointTunerRange;
  series: VPointTunerSeries;
}) {
  return (
    <Paper
      component="section"
      sx={{ minWidth: 0, overflow: "hidden", p: 1.5 }}
      variant="outlined"
    >
      <Box
        sx={{
          alignItems: "center",
          display: "flex",
          gap: 1,
          justifyContent: "space-between",
          mb: 1.5,
        }}
      >
        <Box>
          <Typography component="h3" fontWeight={750} variant="subtitle2">
            Combination #{series.combinationIndex + 1}
          </Typography>
          <Typography color="text.secondary" variant="caption">
            VPoints Summary
          </Typography>
        </Box>
        <Chip
          label={`${combination.vpointsThreshold}% / ${combination.reversalThreshold}%`}
          size="small"
          sx={{ borderColor: color, color }}
          variant="outlined"
        />
      </Box>

      <VPointsSummary
        points={series.points}
        rangeLabel={formatRange(range)}
      />
    </Paper>
  );
}
