"use client";

import type { DynamicTradeConfig, VolatilityPoint } from "@/lib/dynamic";
import type {
  SlowTradingEntryDiagnostic,
  SlowTradingHistoryPosition,
  SlowTradingMode,
} from "@/lib/slowTrading";
import type { PositionRole } from "@/lib/trading/models";

import ArrowDownwardRoundedIcon from "@mui/icons-material/ArrowDownwardRounded";
import ArrowUpwardRoundedIcon from "@mui/icons-material/ArrowUpwardRounded";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Grid,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import moment from "moment-timezone";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import HeaderMetrics from "@/components/ui/HeaderMetrics";
import openPositionPnlContribution from "./open-position-pnl-contribution";
import MissingPositionDecision from "./MissingPositionDecision";
import OpenPositionCoinInfo from "./OpenPositionCoinInfo";
import OpenPositionItem from "./OpenPositionItem";

interface OpenPositionsProps {
  availableTags: string[];
  coinDescriptions: Record<string, string>;
  coinTags: Record<string, string[]>;
  config: DynamicTradeConfig;
  mode: SlowTradingMode;
  exchangeType: DynamicTradeConfig["exchangeType"];
  entryDiagnostics?: SlowTradingEntryDiagnostic[];
  entryDiagnosticsGeneratedAt?: number;
  entryDiagnosticsError?: string;
  entryDiagnosticsLoading?: boolean;
  captureEntryIntervalMinutes?: number;
  captureEntryLastRunAt?: number;
  positions: SlowTradingHistoryPosition[];
  spendableQuoteAsset: number;
  exitingPosition?: {
    account: string;
    role?: PositionRole;
    symbol: string;
  } | null;
  onCoinDescriptionChange: (symbol: string, description: string) => void;
  onCoinTagsChange: (symbol: string, tags: string[]) => void;
  onExit?: (position: SlowTradingHistoryPosition) => Promise<void>;
  onExitBoth?: (position: SlowTradingHistoryPosition) => Promise<void>;
  tagColors: Record<string, string>;
  tagDescriptions: Record<string, string>;
  volatilityMap: Record<string, VolatilityPoint[]>;
  volume24hBySymbol: Record<string, number>;
}

type PnlSortOrder = "best" | "worst";
type PairedPosition = {
  account: string;
  symbol: string;
  main?: SlowTradingHistoryPosition;
  counter?: SlowTradingHistoryPosition;
};

/** Groups account-specific pairs under one visible symbol without losing account order. */
function groupPairsBySymbol(pairs: PairedPosition[]) {
  const groups = new Map<string, PairedPosition[]>();
  for (const pair of pairs) {
    const accountPairs = groups.get(pair.symbol) ?? [];
    accountPairs.push(pair);
    groups.set(pair.symbol, accountPairs);
  }
  return Array.from(groups, ([symbol, accountPairs]) => ({
    symbol,
    accountPairs,
  }));
}

/** Chooses an active leg for shared coin details and account-scoped pair actions. */
function getPairCoinPosition(pair: PairedPosition) {
  return (
    [pair.main, pair.counter].find((position) => position && !position.closed) ??
    pair.main ??
    pair.counter
  );
}

function PairedAccountRow({
  multipleAccounts,
  pair,
  renderPosition,
}: {
  multipleAccounts: boolean;
  pair: PairedPosition;
  renderPosition: (
    title: string,
    role: PositionRole,
    symbol: string,
    position?: SlowTradingHistoryPosition,
    withAccountChip?: boolean,
  ) => ReactNode;
}) {
  const pairPosition = getPairCoinPosition(pair);
  const pairNetUsdt =
    (pair.main?.pnl.netUsdt ?? 0) + (pair.counter?.pnl.netUsdt ?? 0);

  return (
    <Box>
      {multipleAccounts && (
        <Stack alignItems="center" direction="row" gap={1} sx={{ mb: 0.75 }}>
          <Chip
            label={pair.account || "Entry status"}
            size="small"
            variant="outlined"
          />
          <Typography
            color={pairNetUsdt >= 0 ? "success.main" : "error.main"}
            sx={{ fontVariantNumeric: "tabular-nums" }}
            variant="body2"
          >
            ${pairNetUsdt.toFixed(2)}
          </Typography>
          {pairPosition?.opened.t && (
            <Typography color="text.secondary" variant="caption">
              {moment(pairPosition.opened.t).fromNow()}
            </Typography>
          )}
        </Stack>
      )}
      <Grid container spacing={1}>
        {pair.main && (
          <Grid size={{ xs: 12, md: pair.counter ? 6 : 12 }}>
            {renderPosition(
              "Main",
              "MAIN",
              pair.symbol,
              pair.main,
              !multipleAccounts,
            )}
          </Grid>
        )}
        {pair.counter && (
          <Grid size={{ xs: 12, md: pair.main ? 6 : 12 }}>
            {renderPosition(
              "Counter",
              "COUNTER",
              pair.symbol,
              pair.counter,
              !multipleAccounts,
            )}
          </Grid>
        )}
      </Grid>
    </Box>
  );
}

/** Gets the dashboard volatility points for a position symbol. */
function getPositionVolatilityPoints(
  volatilityMap: Record<string, VolatilityPoint[]>,
  symbol: string,
) {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const points =
    volatilityMap[symbol] ??
    volatilityMap[normalizedSymbol] ??
    Object.entries(volatilityMap).find(
      ([key]) => key.trim().toUpperCase() === normalizedSymbol,
    )?.[1];

  return points ?? [];
}

/** Returns a stable copy of the positions ordered by current PnL percentage. */
function sortPositionsByPnl(
  positions: SlowTradingHistoryPosition[],
  order: PnlSortOrder,
) {
  const direction = order === "worst" ? 1 : -1;

  return positions
    .map((position, index) => ({ index, position }))
    .sort((a, b) => {
      const aPnl = Number.isFinite(a.position.pnl.netPct)
        ? (a.position.pnl.netPct ?? 0)
        : 0;
      const bPnl = Number.isFinite(b.position.pnl.netPct)
        ? (b.position.pnl.netPct ?? 0)
        : 0;
      const pnlOrder = (aPnl - bPnl) * direction;
      return pnlOrder === 0 ? a.index - b.index : pnlOrder;
    })
    .map(({ position }) => position);
}

export default function OpenPositions({
  availableTags,
  coinDescriptions,
  coinTags,
  config,
  mode,
  exchangeType,
  entryDiagnostics,
  entryDiagnosticsGeneratedAt,
  entryDiagnosticsError,
  entryDiagnosticsLoading,
  captureEntryLastRunAt,
  positions,
  spendableQuoteAsset,
  exitingPosition,
  onCoinDescriptionChange,
  onCoinTagsChange,
  onExit,
  onExitBoth,
  tagColors,
  tagDescriptions,
  volatilityMap,
  volume24hBySymbol,
}: OpenPositionsProps) {
  const [pnlSortOrder, setPnlSortOrder] = useState<PnlSortOrder>("worst");
  const sortedPositions = useMemo(
    () => sortPositionsByPnl(positions, pnlSortOrder),
    [pnlSortOrder, positions],
  );
  const totalAbsolutePnlUsdt = useMemo(
    () => openPositionPnlContribution.totalAbsolute(positions),
    [positions],
  );
  const isWorstFirst = pnlSortOrder === "worst";

  if (config.openDirection === "BOTH") {
    return (
      <PairedOpenPositions
        availableTags={availableTags}
        coinDescriptions={coinDescriptions}
        coinTags={coinTags}
        config={config}
        entryDiagnostics={entryDiagnostics}
        entryDiagnosticsGeneratedAt={entryDiagnosticsGeneratedAt}
        entryDiagnosticsError={entryDiagnosticsError}
        entryDiagnosticsLoading={entryDiagnosticsLoading}
        captureEntryLastRunAt={captureEntryLastRunAt}
        exchangeType={exchangeType}
        exitingPosition={exitingPosition}
        mode={mode}
        onCoinDescriptionChange={onCoinDescriptionChange}
        onCoinTagsChange={onCoinTagsChange}
        onExit={onExit}
        onExitBoth={onExitBoth}
        positions={positions}
        spendableQuoteAsset={spendableQuoteAsset}
        tagColors={tagColors}
        tagDescriptions={tagDescriptions}
        volatilityMap={volatilityMap}
        volume24hBySymbol={volume24hBySymbol}
      />
    );
  }

  return (
    <HeaderMetrics
      defaultExpanded
      title={
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
          <Typography variant="body1" sx={{ fontWeight: "bold" }}>
            Open Positions ({positions.length})
          </Typography>
          <Tooltip
            arrow
            placement="top"
            title={`PnL: ${isWorstFirst ? "worst" : "best"} first`}
          >
            <IconButton
              aria-label={`Sort PnL ${isWorstFirst ? "best" : "worst"} first`}
              color={isWorstFirst ? "error" : "success"}
              onClick={() =>
                setPnlSortOrder((current) =>
                  current === "worst" ? "best" : "worst",
                )
              }
              size="small"
            >
              {isWorstFirst ? (
                <ArrowUpwardRoundedIcon fontSize="small" />
              ) : (
                <ArrowDownwardRoundedIcon fontSize="small" />
              )}
            </IconButton>
          </Tooltip>
          <Tooltip
            arrow
            placement="top"
            title="Each position stores its latest successful monitoring stage, timestamp, and classification reason. Speedup defaults to 1 minute; Standard Monitoring defaults to 5 minutes."
          >
            <HelpOutlineIcon
              color="action"
              fontSize="small"
              sx={{ cursor: "help" }}
            />
          </Tooltip>
        </Box>
      }
      titleRight={
        <Chip
          label={mode.toUpperCase()}
          size="small"
          color={mode === "sandbox" ? "warning" : "success"}
          variant="outlined"
        />
      }
    >
      {(expanded) =>
        expanded && (
          <Box sx={{ overflowY: "auto", maxHeight: "600px", mt: 1 }}>
            <Stack spacing={1}>
              {sortedPositions.map((position, index) => {
                const volatilityPoints = getPositionVolatilityPoints(
                  volatilityMap,
                  position.symbol,
                );

                return (
                  <OpenPositionItem
                    key={`${position.symbol}-${position.role ?? "MAIN"}-${position.opened.t ?? index}`}
                    availableTags={availableTags}
                    coinDescription={coinDescriptions[position.symbol] ?? ""}
                    coinTags={coinTags[position.symbol] ?? []}
                    config={config}
                    currentVolatilityLevel={volatilityPoints.at(-1)?.lvl}
                    exchangeType={exchangeType}
                    pnlContributionShare={openPositionPnlContribution.share(
                      position.pnl.netUsdt ?? 0,
                      totalAbsolutePnlUsdt,
                    )}
                    position={position}
                    spendableQuoteAsset={spendableQuoteAsset}
                    exitingPosition={exitingPosition}
                    onCoinDescriptionChange={onCoinDescriptionChange}
                    onCoinTagsChange={onCoinTagsChange}
                    onExit={onExit}
                    tagColors={tagColors}
                    tagDescriptions={tagDescriptions}
                    volatilityPoints={volatilityPoints}
                    volume24h={
                      volume24hBySymbol[
                        String(position.symbol || "")
                          .trim()
                          .toUpperCase()
                      ]
                    }
                  />
                );
              })}

              {positions.length === 0 && (
                <Box
                  sx={{
                    border: 1,
                    borderColor: "divider",
                    borderRadius: 1,
                    color: "text.secondary",
                    p: 2,
                    textAlign: "center",
                  }}
                >
                  <Typography variant="body2">No open positions</Typography>
                </Box>
              )}
            </Stack>
          </Box>
        )
      }
    </HeaderMetrics>
  );
}

function PairedOpenPositions(props: OpenPositionsProps) {
  const [currentTimeMs, setCurrentTimeMs] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = window.setInterval(
      () => setCurrentTimeMs(Date.now()),
      30_000,
    );
    return () => window.clearInterval(intervalId);
  }, []);

  // Open-position UI never renders archived/legacy retained closed legs.
  const activePositions = props.positions.filter((position) => !position.closed);
  const configuredPairs = new Map<string, PairedPosition>(
    (props.config.symbols ?? []).map((rawSymbol) => {
      const symbol = rawSymbol.trim().toUpperCase();
      return [
        `:${symbol}`,
        {
          account: "",
          symbol,
        },
      ];
    }),
  );
  const pairs = Array.from(
    activePositions.reduce((map, position) => {
      const symbol = position.symbol.trim().toUpperCase();
      const key = `${position.account}:${symbol}`;
      map.delete(`:${symbol}`);
      const current = map.get(key) ?? {
        account: position.account,
        symbol,
      };
      if (position.role === "COUNTER") {
        current.counter = position;
      } else {
        current.main = position;
      }
      map.set(key, current);
      return map;
    }, configuredPairs),
  ).map(([, pair]) => pair);
  const symbolGroups = groupPairsBySymbol(pairs);

  const totalAbsolutePnlUsdt = openPositionPnlContribution.totalAbsolute(
    activePositions,
  );
  const renderPosition = (
    title: string,
    role: PositionRole,
    symbol: string,
    position?: SlowTradingHistoryPosition,
    withAccountChip = true,
  ) => {
    if (!position) {
      return (
        <MissingPositionDecision
          captureEntryIntervalMinutes={props.captureEntryIntervalMinutes}
          captureEntryLastRunAt={props.captureEntryLastRunAt}
          currentTimeMs={currentTimeMs}
          diagnostics={props.entryDiagnostics}
          error={props.entryDiagnosticsError}
          generatedAt={props.entryDiagnosticsGeneratedAt}
          loading={props.entryDiagnosticsLoading}
          role={role}
          symbol={symbol}
          title={title}
        />
      );
    }
    const volatilityPoints = getPositionVolatilityPoints(
      props.volatilityMap,
      position.symbol,
    );
    return (
      <OpenPositionItem
        availableTags={props.availableTags}
        coinDescription={props.coinDescriptions[position.symbol] ?? ""}
        coinTags={props.coinTags[position.symbol] ?? []}
        config={props.config}
        currentVolatilityLevel={volatilityPoints.at(-1)?.lvl}
        exchangeType={props.exchangeType}
        exitingPosition={props.exitingPosition}
        onCoinDescriptionChange={props.onCoinDescriptionChange}
        onCoinTagsChange={props.onCoinTagsChange}
        onExit={props.onExit}
        pnlContributionShare={openPositionPnlContribution.share(
          position.pnl.netUsdt ?? 0,
          totalAbsolutePnlUsdt,
        )}
        position={position}
        spendableQuoteAsset={props.spendableQuoteAsset}
        tagColors={props.tagColors}
        tagDescriptions={props.tagDescriptions}
        title={title}
        volatilityPoints={volatilityPoints}
        volume24h={
          props.volume24hBySymbol[position.symbol.trim().toUpperCase()]
        }
        withAccountChip={withAccountChip}
        withCoinInfo={false}
        withOpenedAge={false}
      />
    );
  };

  return (
    <HeaderMetrics
      defaultExpanded
      title={
        <Typography variant="body1" sx={{ fontWeight: "bold" }}>
          Open Position ({symbolGroups.length} symbols)
        </Typography>
      }
      titleRight={
        <Chip
          color={props.mode === "sandbox" ? "warning" : "success"}
          label={props.mode.toUpperCase()}
          size="small"
          variant="outlined"
        />
      }
      toggleLabel="open positions"
    >
      {(expanded) =>
        expanded && (
          <Stack gap={1.5} mt={1}>
            {symbolGroups.map(({ symbol, accountPairs }) => {
              const netUsdt = accountPairs.reduce(
                (total, pair) =>
                  total +
                  (pair.main?.pnl.netUsdt ?? 0) +
                  (pair.counter?.pnl.netUsdt ?? 0),
                0,
              );
              const coinPosition = accountPairs
                .map(getPairCoinPosition)
                .find((position) => position && !position.closed);
              const multipleAccounts = accountPairs.length > 1;
              const hasOpenPair = accountPairs.some(
                (pair) => pair.main || pair.counter,
              );
              const hasMissingMain = accountPairs.some((pair) => !pair.main);
              const hasMissingCounter = accountPairs.some(
                (pair) => !pair.counter,
              );

              return (
                <HeaderMetrics
                  key={symbol}
                  rememberExpand={
                    multipleAccounts
                      ? `open-position-${symbol}`
                      : `open-position-${accountPairs[0].account}-${symbol}`
                  }
                  toggleLabel={`${symbol} position`}
                  sx={{
                    bgcolor: "background.paper",
                    p: 1,
                    borderRadius: "5px",
                  }}
                  title={
                    <Box
                      sx={{
                        display: "grid",
                        gap: 1.5,
                        gridTemplateColumns: {
                          xs: "minmax(0, 1fr)",
                          lg: "minmax(140px, 1fr) minmax(0, 2fr)",
                        },
                      }}
                    >
                      <Box>
                        <Typography fontWeight={800}>{symbol}</Typography>
                        <Typography
                          color={netUsdt >= 0 ? "success.main" : "error.main"}
                          sx={{ fontVariantNumeric: "tabular-nums" }}
                          variant="body1"
                        >
                          ${netUsdt.toFixed(2)}
                        </Typography>
                        <Typography color="text.secondary" variant="caption">
                          {multipleAccounts
                            ? `Total across ${accountPairs.length} accounts`
                            : coinPosition?.opened.t
                            ? moment(coinPosition.opened.t).fromNow()
                            : "-"}
                        </Typography>
                      </Box>
                      <Stack
                        divider={multipleAccounts ? <Divider flexItem /> : undefined}
                        gap={multipleAccounts ? 1 : 0}
                        sx={{ minWidth: 0 }}
                      >
                        {accountPairs
                          .filter((pair) => pair.main || pair.counter)
                          .map((pair) => (
                            <PairedAccountRow
                              key={`${pair.account}:${pair.symbol}`}
                              multipleAccounts={multipleAccounts}
                              pair={pair}
                              renderPosition={renderPosition}
                            />
                          ))}
                        {(hasMissingMain || hasMissingCounter) && (
                          <Box>
                            {hasOpenPair && !multipleAccounts && (
                              <Divider sx={{ mb: 1 }} />
                            )}
                            {multipleAccounts && (
                              <Typography
                                color="text.secondary"
                                sx={{ display: "block", mb: 0.5 }}
                                variant="caption"
                              >
                                Entry status across accounts
                              </Typography>
                            )}
                            <Grid container spacing={1}>
                              {hasMissingMain && (
                                <Grid size={{ xs: 12, md: 6 }}>
                                  {renderPosition("Main", "MAIN", symbol)}
                                </Grid>
                              )}
                              {hasMissingCounter && (
                                <Grid size={{ xs: 12, md: 6 }}>
                                  {renderPosition("Counter", "COUNTER", symbol)}
                                </Grid>
                              )}
                            </Grid>
                          </Box>
                        )}
                      </Stack>
                    </Box>
                  }
                >
                  {(expandedChild) =>
                    expandedChild && (
                      <Box>
                        {coinPosition && (
                          <OpenPositionCoinInfo
                            actions={
                              <Stack direction="row" flexWrap="wrap" gap={1}>
                                {accountPairs.map((pair) => {
                                  const pairPosition = getPairCoinPosition(pair);
                                  if (!pairPosition) return null;
                                  const hasExitPendingForPair =
                                    props.exitingPosition?.account ===
                                      pair.account &&
                                    props.exitingPosition.symbol === symbol;
                                  const isExitingPair =
                                    hasExitPendingForPair &&
                                    !props.exitingPosition?.role;
                                  return (
                                    <Button
                                      key={pair.account}
                                      color="error"
                                      disabled={
                                        !props.onExitBoth ||
                                        hasExitPendingForPair
                                      }
                                      onClick={() =>
                                        void props.onExitBoth?.(pairPosition)
                                      }
                                      size="small"
                                      sx={{ textTransform: "none" }}
                                      title={`Close both ${symbol} legs on ${pair.account}`}
                                      variant="outlined"
                                    >
                                      {isExitingPair ? (
                                        <CircularProgress
                                          color="inherit"
                                          size={16}
                                        />
                                      ) : multipleAccounts ? (
                                        `Close Both · ${pair.account}`
                                      ) : (
                                        "Close Both"
                                      )}
                                    </Button>
                                  );
                                })}
                              </Stack>
                            }
                            availableTags={props.availableTags}
                            coinDescription={
                              props.coinDescriptions[coinPosition.symbol] ?? ""
                            }
                            coinTags={props.coinTags[coinPosition.symbol] ?? []}
                            config={props.config}
                            onCoinDescriptionChange={
                              props.onCoinDescriptionChange
                            }
                            onCoinTagsChange={props.onCoinTagsChange}
                            position={coinPosition}
                            tagColors={props.tagColors}
                            tagDescriptions={props.tagDescriptions}
                            volume24h={
                              props.volume24hBySymbol[
                                coinPosition.symbol.trim().toUpperCase()
                              ]
                            }
                          />
                        )}
                      </Box>
                    )
                  }
                </HeaderMetrics>
              );
            })}

            {symbolGroups.length === 0 && (
              <Typography color="text.secondary">No open positions</Typography>
            )}
          </Stack>
        )
      }
    </HeaderMetrics>
  );
}
