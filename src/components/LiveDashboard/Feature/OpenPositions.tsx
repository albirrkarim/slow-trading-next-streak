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
  Grid,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import moment from "moment-timezone";
import { useMemo, useState } from "react";

import HeaderMetrics from "@/components/ui/HeaderMetrics";
import openPositionPnlContribution from "./open-position-pnl-contribution";
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
  // Open-position UI never renders archived/legacy retained closed legs.
  const activePositions = props.positions.filter((position) => !position.closed);
  const configuredPairs = new Map<
    string,
    {
      account: string;
      symbol: string;
      main?: SlowTradingHistoryPosition;
      counter?: SlowTradingHistoryPosition;
    }
  >(
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

  const totalAbsolutePnlUsdt = openPositionPnlContribution.totalAbsolute(
    activePositions,
  );
  const renderPosition = (
    title: string,
    role: PositionRole,
    symbol: string,
    position?: SlowTradingHistoryPosition,
  ) => {
    if (!position) {
      const diagnostic =
        props.entryDiagnostics?.find(
          (item) =>
            item.symbol.trim().toUpperCase() === symbol && item.role === role,
        ) ??
        props.entryDiagnostics?.find(
          (item) =>
            item.symbol.trim().toUpperCase() === symbol && !item.role,
        );
      const reason = props.entryDiagnosticsLoading
        ? `Evaluating why ${role} is not open...`
        : props.entryDiagnosticsError
          ? `Unable to load the ${role} entry reason: ${props.entryDiagnosticsError}`
          : diagnostic?.reason ??
            `No current ${role} entry decision is available.`;
      const diagnosticMeta = diagnostic
        ? [
            diagnostic.code,
            diagnostic.pointId,
            typeof diagnostic.level === "number"
              ? `Level ${diagnostic.level}`
              : undefined,
          ].filter(Boolean).join(" · ")
        : "";
      const decisionCheckedAt = props.entryDiagnosticsGeneratedAt ?? 0;
      const captureEntryLastRunAt = props.captureEntryLastRunAt ?? 0;
      const timingMeta = [
        decisionCheckedAt > 0
          ? `Decision checked ${moment(decisionCheckedAt).format("D MMM HH:mm:ss")}`
          : "Decision check time unavailable",
        captureEntryLastRunAt > 0
          ? `Capture Entry completed ${moment(captureEntryLastRunAt).format("D MMM HH:mm:ss")}`
          : "Capture Entry has never completed",
      ].join(" · ");
      const awaitsNextCaptureEntry =
        diagnostic?.status === "ready" &&
        decisionCheckedAt > captureEntryLastRunAt;

      return (
        <HeaderMetrics
          defaultExpanded
          title={<Typography fontWeight={700}>{title}</Typography>}
          titleRight={
            diagnostic && (
              <Chip
                color={
                  diagnostic.status === "ready" ? "success" : "warning"
                }
                label={
                  diagnostic.status === "ready" ? "Ready" : "Blocked"
                }
                size="small"
                variant="outlined"
              />
            )
          }
          toggleLabel={`${title} details`}
          sx={{ border: 1, borderColor: "divider" }}
          headerSx={{ p: 0.5 }}
        >
          {(expanded) =>
            expanded && (
              <Box sx={{ borderTop: 1, borderColor: "divider", p: 1.5 }}>
                <Typography color="text.secondary" variant="body2">
                  {reason}
                </Typography>
                {awaitsNextCaptureEntry && (
                  <Typography color="success.main" sx={{ display: "block", mt: 0.5 }} variant="caption">
                    Ready after the last Capture Entry pass; execution has not
                    checked this state yet.
                  </Typography>
                )}
                <Typography
                  color="text.disabled"
                  sx={{ display: "block", mt: 0.5 }}
                  variant="caption"
                >
                  {timingMeta}
                </Typography>
                {diagnostic && (
                  <Typography
                    color="text.disabled"
                    sx={{ display: "block", mt: 0.5 }}
                    variant="caption"
                  >
                    {diagnosticMeta}
                  </Typography>
                )}
              </Box>
            )
          }
        </HeaderMetrics>
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
          Open Position ({pairs.length})
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
            {pairs.map((pair) => {
              const netUsdt =
                (pair.main?.pnl.netUsdt ?? 0) +
                (pair.counter?.pnl.netUsdt ?? 0);
              const hasExitPendingForPair =
                props.exitingPosition?.account === pair.account &&
                props.exitingPosition.symbol === pair.symbol;
              const isExitingPair =
                hasExitPendingForPair && !props.exitingPosition?.role;
              const coinPosition =
                [pair.main, pair.counter].find(
                  (position) => position && !position.closed,
                ) ??
                pair.main ??
                pair.counter;

              return (
                <HeaderMetrics
                  key={`${pair.account}:${pair.symbol}`}
                  rememberExpand={`open-position-${pair.account}-${pair.symbol}`}
                  toggleLabel={`${pair.symbol} position`}
                  sx={{
                    bgcolor: "background.paper",
                    p: 1,
                    borderRadius: "5px",
                  }}
                  title={
                    <Box
                      sx={{
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <Box sx={{ mr: 2 }}>
                        <Typography fontWeight={800}>
                          {pair.symbol}
                          <Typography
                            color={netUsdt >= 0 ? "success.main" : "error.main"}
                            sx={{
                              fontVariantNumeric: "tabular-nums",
                              ml: 1,
                              display: {
                                lg: "inline",
                                md: "none",
                                sm: "none",
                                xs: "none",
                              },
                            }}
                            variant="body1"
                            component="span"
                          >
                            ${netUsdt.toFixed(2)}
                          </Typography>
                        </Typography>

                        <Typography
                          color={netUsdt >= 0 ? "success.main" : "error.main"}
                          sx={{
                            fontVariantNumeric: "tabular-nums",
                            display: {
                              lg: "none",
                              md: "block",
                              sm: "block",
                              xs: "block",
                            },
                          }}
                          variant="body1"
                        >
                          ${netUsdt.toFixed(2)}
                        </Typography>

                        <Typography color="text.secondary" variant="caption">
                          {coinPosition?.opened.t
                            ? moment(coinPosition.opened.t).fromNow()
                            : "-"}
                        </Typography>
                      </Box>
                      <Grid
                        container
                        spacing={1}
                        sx={{
                          minWidth: {
                            xl: "1000px",
                          },
                        }}
                      >
                        <Grid size={{ xs: 12, sm: 12, md: 6, lg: 6 }}>
                          {renderPosition(
                            "Main",
                            "MAIN",
                            pair.symbol,
                            pair.main,
                          )}
                        </Grid>
                        <Grid size={{ xs: 12, sm: 12, md: 6, lg: 6 }}>
                          {renderPosition(
                            "Counter",
                            "COUNTER",
                            pair.symbol,
                            pair.counter,
                          )}
                        </Grid>
                      </Grid>
                    </Box>
                  }
                >
                  {(expandedChild) =>
                    expandedChild && (
                      <Box>
                        {coinPosition && (
                          <OpenPositionCoinInfo
                            actions={
                              <Button
                                color="error"
                                disabled={
                                  !props.onExitBoth || hasExitPendingForPair
                                }
                                onClick={() =>
                                  coinPosition &&
                                  void props.onExitBoth?.(coinPosition)
                                }
                                size="small"
                                sx={{ textTransform: "none" }}
                                title={`Close both ${pair.symbol} legs`}
                                variant="outlined"
                              >
                                {isExitingPair ? (
                                  <CircularProgress color="inherit" size={16} />
                                ) : (
                                  "Close Both"
                                )}
                              </Button>
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

            {pairs.length === 0 && (
              <Typography color="text.secondary">No open positions</Typography>
            )}
          </Stack>
        )
      }
    </HeaderMetrics>
  );
}
