"use client";

import { endpoints } from "@/components/endpoints";
import type { Marker } from "@/components/LiveDashboard/converter";
import CurrencyChart from "@/components/LiveDashboard/Shared/CurrencyChart";
import ButtonDialog from "@/components/ui/ButtonDialog";
import type {
  VPointTunerChartKlines,
  VPointTunerCombination,
  VPointTunerPoint,
  VPointTunerRange,
} from "@/lib/devBacktest/vpoints";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Typography from "@mui/material/Typography";
import type { UTCTimestamp } from "lightweight-charts";
import { useEffect, useMemo, useState } from "react";

function VPointKlinesChart({
  color,
  combination,
  points,
  range,
  symbol,
}: {
  color: string;
  combination: VPointTunerCombination;
  points: VPointTunerPoint[];
  range: VPointTunerRange;
  symbol: string;
}) {
  const [data, setData] = useState<VPointTunerChartKlines | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      try {
        const response = await fetch(endpoints.dev.vpoints, {
          body: JSON.stringify({ action: "klines", range, symbol }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
          signal: controller.signal,
        });
        const result = (await response.json()) as VPointTunerChartKlines & {
          error?: string;
        };
        if (!response.ok) {
          throw new Error(result.error ?? "Failed to load prepared klines");
        }
        setData(result);
      } catch (loadError) {
        if (controller.signal.aborted) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load prepared klines",
        );
      }
    }

    void load();
    return () => controller.abort();
  }, [range, symbol]);

  const markers = useMemo<Marker[]>(
    () =>
      points.map((point) => ({
        color,
        position: point.l === "B" ? "belowBar" : "aboveBar",
        price: point.p,
        shape: point.l === "B" ? "arrowUp" : "arrowDown",
        text: `${point.l}[${point.lvl}] ${point.pct}%`,
        time: Math.floor(point.t / 1000) as UTCTimestamp,
        tooltipText: [
          new Date(point.t).toLocaleString(),
          `Price: ${point.p}`,
          `Move: ${point.pct}%`,
          `Level: ${point.lvl}`,
        ].join("\n"),
        tooltipTitle: `${point.l === "B" ? "BOTTOM" : "TOP"} vPoint`,
      })),
    [color, points],
  );

  if (error) return <Alert severity="error">{error}</Alert>;
  if (!data) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 10 }}>
        <CircularProgress aria-label="Loading prepared klines" />
      </Box>
    );
  }

  const candles = data.candles.map(([t, o, h, l, c, v]) => ({
    close: c,
    high: h,
    low: l,
    open: o,
    time: Math.floor(t / 1000),
    volume: v,
  }));

  return (
    <Box sx={{ backgroundColor: "background.default", p: { xs: 0.5, sm: 1 } }}>
      <Box
        sx={{
          alignItems: { sm: "center" },
          display: "flex",
          flexDirection: { xs: "column", sm: "row" },
          gap: 1,
          justifyContent: "space-between",
          mb: 1,
        }}
      >
        <Typography color="text.secondary" variant="body2">
          {data.candles.length.toLocaleString()} Binance Futures 5m candles · {" "}
          {points.length.toLocaleString()} vPoint markers
        </Typography>
        <Chip
          label={`${combination.vpointsThreshold}% move · ${combination.reversalThreshold}% reversal`}
          size="small"
          sx={{ borderColor: color, color }}
          variant="outlined"
        />
      </Box>
      <CurrencyChart
        data={candles}
        entryOrders={[]}
        height={560}
        markers={markers}
      />
    </Box>
  );
}

export default function VPointKlinesDialog({
  color,
  combination,
  combinationIndex,
  label,
  points,
  range,
  symbol,
}: {
  color: string;
  combination: VPointTunerCombination;
  combinationIndex: number;
  label: string;
  points: VPointTunerPoint[];
  range: VPointTunerRange;
  symbol: string;
}) {
  return (
    <ButtonDialog
      contentSx={{ p: { xs: 0.5, sm: 1 } }}
      customButton={(open) => (
        <Chip
          aria-label={`View ${symbol} klines for combination ${combinationIndex + 1}`}
          clickable
          label={label}
          onClick={open}
          size="small"
          sx={{
            borderColor: color,
            cursor: "pointer",
            "&::before": {
              backgroundColor: color,
              borderRadius: "50%",
              content: '""',
              height: 7,
              ml: 0.75,
              width: 7,
            },
            "&:hover": { backgroundColor: `${color}18` },
          }}
          title={`View ${symbol} Futures klines with combination ${combinationIndex + 1} vPoints`}
          variant="outlined"
        />
      )}
      maxWidth="xl"
      title="View klines"
      titleLong={`${symbol} — Combination #${combinationIndex + 1} Klines & vPoints`}
    >
      {() => (
        <VPointKlinesChart
          color={color}
          combination={combination}
          points={points}
          range={range}
          symbol={symbol}
        />
      )}
    </ButtonDialog>
  );
}
