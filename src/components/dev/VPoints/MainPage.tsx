"use client";

import { endpoints } from "@/components/endpoints";
import type {
  VPointTunerAnalysis,
  VPointTunerCombination,
  VPointTunerPreparedKlines,
  VPointTunerRange,
} from "@/lib/devBacktest/vpoints";
import AnalyticsOutlinedIcon from "@mui/icons-material/AnalyticsOutlined";
import StorageOutlinedIcon from "@mui/icons-material/StorageOutlined";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import LinearProgress from "@mui/material/LinearProgress";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useMemo, useState } from "react";
import CoinVPointsChart from "./CoinVPointsChart";
import CombinationEditor from "./CombinationEditor";

const DEFAULT_SYMBOLS = "BTC, ETH, SOL";
const MAX_COMBINATIONS = 10;
const DEFAULT_COMBINATIONS: VPointTunerCombination[] = [
  { reversalThreshold: 1, vpointsThreshold: 2 },
  { reversalThreshold: 1, vpointsThreshold: 3 },
  { reversalThreshold: 1, vpointsThreshold: 5 },
];

type SymbolStatus =
  | { state: "preparing" }
  | { state: "prepared"; data: VPointTunerPreparedKlines }
  | { state: "failed"; message: string };

function parseSymbols(value: string) {
  return [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map((symbol) =>
          symbol.trim().toUpperCase().replace(/_?USDT$/, ""),
        )
        .filter(Boolean),
    ),
  ];
}

async function post<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch(endpoints.dev.vpoints, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(data.error ?? "VPoint tuner request failed");
  }
  return data;
}

export default function VPointsPage() {
  const [symbolsText, setSymbolsText] = useState(DEFAULT_SYMBOLS);
  const [range, setRange] = useState<VPointTunerRange>("6month");
  const [combinations, setCombinations] = useState(DEFAULT_COMBINATIONS);
  const [statuses, setStatuses] = useState<Record<string, SymbolStatus>>({});
  const [analyses, setAnalyses] = useState<Record<string, VPointTunerAnalysis>>(
    {},
  );
  const [error, setError] = useState("");
  const [isPreparing, setIsPreparing] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const symbols = useMemo(() => parseSymbols(symbolsText), [symbolsText]);
  const isBusy = isPreparing || isAnalyzing;
  const preparedCount = symbols.filter(
    (symbol) => statuses[symbol]?.state === "prepared",
  ).length;
  const allPrepared = symbols.length > 0 && preparedCount === symbols.length;
  const combinationsValid =
    combinations.length > 0 &&
    combinations.every(
      (combination) =>
        Number.isFinite(combination.vpointsThreshold) &&
        combination.vpointsThreshold > 0 &&
        Number.isFinite(combination.reversalThreshold) &&
        combination.reversalThreshold > 0,
    );

  function resetPreparedState() {
    setStatuses({});
    setAnalyses({});
    setError("");
  }

  async function prepare() {
    if (symbols.length === 0) {
      setError("Enter at least one symbol");
      return;
    }
    setError("");
    setAnalyses({});
    setStatuses({});
    setIsPreparing(true);
    const failures: string[] = [];

    for (const symbol of symbols) {
      setStatuses((current) => ({
        ...current,
        [symbol]: { state: "preparing" },
      }));
      try {
        const data = await post<VPointTunerPreparedKlines>({
          action: "prepare",
          range,
          symbol,
        });
        setStatuses((current) => ({
          ...current,
          [symbol]: { data, state: "prepared" },
        }));
      } catch (prepareError) {
        const message =
          prepareError instanceof Error
            ? prepareError.message
            : `Failed to prepare ${symbol}`;
        failures.push(`${symbol}: ${message}`);
        setStatuses((current) => ({
          ...current,
          [symbol]: { message, state: "failed" },
        }));
      }
    }

    if (failures.length > 0) setError(failures.join(" · "));
    setIsPreparing(false);
  }

  async function compare() {
    if (!allPrepared || !combinationsValid) return;
    setError("");
    setAnalyses({});
    setIsAnalyzing(true);
    const failures: string[] = [];

    for (const symbol of symbols) {
      try {
        const analysis = await post<VPointTunerAnalysis>({
          action: "analyze",
          combinations,
          range,
          symbol,
        });
        setAnalyses((current) => ({ ...current, [symbol]: analysis }));
      } catch (analysisError) {
        const message =
          analysisError instanceof Error
            ? analysisError.message
            : `Failed to analyze ${symbol}`;
        failures.push(`${symbol}: ${message}`);
      }
    }

    if (failures.length > 0) setError(failures.join(" · "));
    setIsAnalyzing(false);
  }

  return (
    <Box
      component="main"
      sx={{
        display: "grid",
        gap: 2.5,
        p: { xs: 1.5, sm: 2, md: 3 },
        width: "100%",
      }}
    >
      <Box
        sx={{
          alignItems: { md: "flex-end" },
          display: "flex",
          flexDirection: { xs: "column", md: "row" },
          gap: 1.5,
          justifyContent: "space-between",
        }}
      >
        <Box>
          <Typography component="h1" fontWeight={850} variant="h4">
            VPoint threshold tuner
          </Typography>
          <Typography color="text.secondary" sx={{ mt: 0.5, maxWidth: 780 }}>
            Compare how move and reversal percentages reshape volatility levels
            across the same Binance Futures five-minute candles.
          </Typography>
        </Box>
        <Chip
          color="success"
          label="DEV ONLY · disk cache · request-scoped RAM"
          size="small"
          variant="outlined"
        />
      </Box>

      <Paper component="section" variant="outlined" sx={{ p: { xs: 1.5, md: 2 } }}>
        <Box
          sx={{
            alignItems: "start",
            display: "grid",
            gap: 1.5,
            gridTemplateColumns: {
              xs: "minmax(0, 1fr)",
              md: "minmax(280px, 1fr) 180px auto auto",
            },
          }}
        >
          <TextField
            disabled={isBusy}
            fullWidth
            helperText={`${symbols.length} symbol${symbols.length === 1 ? "" : "s"}; comma or space separated (maximum 12)`}
            label="Symbols"
            onChange={(event) => {
              setSymbolsText(event.target.value);
              resetPreparedState();
            }}
            placeholder="BTC, ETH, SOL"
            value={symbolsText}
          />
          <FormControl disabled={isBusy} fullWidth>
            <InputLabel id="vpoint-range-label">Time range</InputLabel>
            <Select
              label="Time range"
              labelId="vpoint-range-label"
              onChange={(event) => {
                setRange(event.target.value as VPointTunerRange);
                resetPreparedState();
              }}
              value={range}
            >
              <MenuItem value="6month">6 months</MenuItem>
              <MenuItem value="1year">1 year</MenuItem>
              <MenuItem value="2year">2 years</MenuItem>
            </Select>
          </FormControl>
          <Button
            disabled={isBusy || symbols.length === 0 || symbols.length > 12}
            onClick={() => void prepare()}
            startIcon={
              isPreparing ? <CircularProgress size={18} /> : <StorageOutlinedIcon />
            }
            sx={{ minHeight: 56, minWidth: 168 }}
            variant="contained"
          >
            {isPreparing ? `Preparing ${preparedCount + 1}/${symbols.length}` : "Prepare klines"}
          </Button>
          <Button
            disabled={isBusy || !allPrepared || !combinationsValid}
            onClick={() => void compare()}
            startIcon={
              isAnalyzing ? (
                <CircularProgress size={18} />
              ) : (
                <AnalyticsOutlinedIcon />
              )
            }
            sx={{ minHeight: 56, minWidth: 190 }}
            variant="outlined"
          >
            {isAnalyzing ? "Comparing…" : "Compare combinations"}
          </Button>
        </Box>

        {isBusy && <LinearProgress sx={{ mt: 1.5 }} />}
        {Object.keys(statuses).length > 0 && (
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75, mt: 1.5 }}>
            {symbols.map((symbol) => {
              const status = statuses[symbol];
              if (!status) return null;
              if (status.state === "preparing") {
                return <Chip key={symbol} label={`${symbol} · preparing`} size="small" />;
              }
              if (status.state === "failed") {
                return (
                  <Chip
                    color="error"
                    key={symbol}
                    label={`${symbol} · failed`}
                    size="small"
                    title={status.message}
                  />
                );
              }
              return (
                <Chip
                  color="success"
                  key={symbol}
                  label={`${symbol} · ${status.data.candleCount.toLocaleString()} candles · ${status.data.cached ? "cached" : "downloaded"}`}
                  size="small"
                  variant="outlined"
                />
              );
            })}
          </Box>
        )}
      </Paper>

      <CombinationEditor
        combinations={combinations}
        disabled={isBusy}
        maxCombinations={MAX_COMBINATIONS}
        onChange={(next) => {
          setCombinations(next);
          setAnalyses({});
          setError("");
        }}
      />

      {error && <Alert severity="error">{error}</Alert>}

      {allPrepared && Object.keys(analyses).length === 0 && !isAnalyzing && (
        <Alert severity="info">
          Klines are ready on dev storage. Adjust combinations if needed, then
          select Compare combinations.
        </Alert>
      )}

      {Object.keys(analyses).length > 0 && (
        <Box sx={{ display: "grid", gap: 2.5 }}>
          {symbols.map((symbol) =>
            analyses[symbol] ? (
              <CoinVPointsChart
                analysis={analyses[symbol]}
                combinations={combinations}
                key={symbol}
              />
            ) : null,
          )}
        </Box>
      )}
    </Box>
  );
}
