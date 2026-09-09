"use client";

import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import LoginIcon from "@mui/icons-material/Login";
import LogoutIcon from "@mui/icons-material/Logout";
import { useEffect, useState } from "react";
import {
  Box,
  Divider,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha, type Theme } from "@mui/material/styles";
import type { SlowTradingDashboardState } from "@/lib/slowTrading";

import ReadMoreDialogButton from "../Navbar/ReadMoreDialogButton";
import ExitThresholdChart from "../Navbar/ExitThresholdChart";
import AveragingSimulationPreview from "./AveragingSimulationPreview";
import {
  buildTradingLivePreview,
  type TradingLivePreviewConfig,
  type TradingLivePreviewExitStage,
} from "./trading-live-preview";

function formatUsdt(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(value);
}

function parseSpendableAssumption(value: string) {
  if (value.trim() === "") {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined;
}

function PreviewMetric({
  color,
  label,
  value,
  valueTooltip,
}: {
  color?: string;
  label: string;
  value: string;
  valueTooltip?: string;
}) {
  const valueElement = (
    <Typography
      color={color}
      fontWeight={700}
      sx={{
        borderBottom: valueTooltip ? "1px dotted" : undefined,
        cursor: valueTooltip ? "help" : undefined,
        fontVariantNumeric: "tabular-nums",
        textAlign: "right",
      }}
      variant="body2"
    >
      {value}
    </Typography>
  );

  return (
    <Box
      sx={{
        alignItems: "baseline",
        display: "flex",
        gap: 1,
        justifyContent: "space-between",
        minWidth: 0,
      }}
    >
      <Typography color="text.secondary" variant="body2">
        {label}
      </Typography>
      {!valueTooltip && valueElement}
      {valueTooltip && (
        <Tooltip arrow describeChild placement="top" title={valueTooltip}>
          {valueElement}
        </Tooltip>
      )}
    </Box>
  );
}

function PreviewCalculation({
  color,
  detail,
  formula,
  label,
  labelAction,
}: {
  color?: string;
  detail: string;
  formula: string;
  label: string;
  labelAction?: React.ReactNode;
}) {
  return (
    <Box sx={{ mb: 0.5 }}>
      <Stack alignItems="center" direction="row" gap={0.25}>
        <Typography color="text.secondary" variant="caption">
          {label}
        </Typography>
        {labelAction}
      </Stack>
      <Tooltip
        arrow
        describeChild
        placement="top"
        title={detail}
      >
        <Typography
          color={color}
          fontWeight={700}
          sx={{
            borderBottom: "1px dotted",
            cursor: "help",
            fontVariantNumeric: "tabular-nums",
            maxWidth: "100%",
            overflowWrap: "anywhere",
            width: "fit-content",
          }}
          variant="body2"
        >
          {formula}
        </Typography>
      </Tooltip>
    </Box>
  );
}

/** Resolves the semantic leg color with a fallback for isolated default themes. */
function getPositionRoleColor(
  theme: Theme,
  role: "counter" | "main",
) {
  return (
    theme.palette.positionRole?.[role] ??
    (role === "main"
      ? theme.palette.primary.main
      : theme.palette.mode === "dark"
        ? "#a78bfa"
        : "#6d28d9")
  );
}

function StageLegGroup({
  children,
  label,
  role,
  testId,
  wide = false,
}: {
  children: React.ReactNode;
  label: string;
  role: "counter" | "main";
  testId: string;
  wide?: boolean;
}) {
  return (
    <Box
      aria-label={`${label} calculations`}
      component="section"
      data-testid={testId}
      sx={(theme) => {
        const roleColor = getPositionRoleColor(theme, role);

        return {
          backgroundColor: alpha(
            roleColor,
            theme.palette.mode === "dark" ? 0.12 : 0.05,
          ),
          border: "1px solid",
          borderColor: alpha(roleColor, 0.35),
          borderLeftColor: roleColor,
          borderLeftWidth: 3,
          borderRadius: 1,
          gridColumn: wide ? "1 / -1" : undefined,
          minWidth: 0,
          p: 1.25,
        };
      }}
    >
      <Typography
        fontWeight={800}
        sx={(theme) => ({
          color: getPositionRoleColor(theme, role),
          letterSpacing: "0.04em",
          mb: 0.75,
        })}
        variant="caption"
      >
        {label}
      </Typography>
      <Box
        sx={{
          columnGap: 1.5,
          display: "grid",
          gridTemplateColumns: wide
            ? { xs: "minmax(0, 1fr)", sm: "repeat(2, minmax(0, 1fr))" }
            : "minmax(0, 1fr)",
          rowGap: 0.75,
        }}
      >
        {children}
      </Box>
    </Box>
  );
}

function StageStopOutcome({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <Box
      aria-label={`${label} calculations`}
      component="section"
      data-testid="stage-stop-outcome"
      sx={{
        backgroundColor: "action.hover",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 1,
        gridColumn: "1 / -1",
        minWidth: 0,
        p: 1.25,
      }}
    >
      <Typography
        color="text.primary"
        fontWeight={800}
        sx={{ letterSpacing: "0.04em", mb: 0.75 }}
        variant="caption"
      >
        {label}
      </Typography>
      <Box
        sx={{
          columnGap: 1.5,
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr)",
          rowGap: 0.75,
        }}
      >
        {children}
      </Box>
    </Box>
  );
}

function ExitStagePreview({
  bothDirection,
  entryLegs,
  leverage,
  stage,
  stopLossPct,
  stopLossUSDT,
  takeProfitPct,
  targetZoneStopLossPct,
}: {
  bothDirection: boolean;
  entryLegs: "MAIN" | "COUNTER" | "BOTH";
  leverage: number;
  stage: TradingLivePreviewExitStage;
  stopLossPct: number | null;
  stopLossUSDT: number | null;
  takeProfitPct: number;
  targetZoneStopLossPct: number | null;
}) {
  const marginFormula = `${stage.marginPartsUsdt
    .map(formatUsdt)
    .join(" + ")} = ${formatUsdt(stage.cumulativeMarginUsdt)}`;
  const notionalFormula = `${formatUsdt(
    stage.cumulativeMarginUsdt,
  )} x ${leverage}x = ${formatUsdt(stage.estimatedNotionalUsdt)}`;
  const profitFormula = `${formatUsdt(
    stage.estimatedNotionalUsdt,
  )} x ${takeProfitPct}% = +${formatUsdt(stage.estimatedProfitUsdt)}`;
  const lossFormula =
    stage.estimatedLossUsdt === null
      ? "Stop loss disabled"
      : `${formatUsdt(stage.estimatedNotionalUsdt)} x ${stopLossPct
      }% = -${formatUsdt(stage.estimatedLossUsdt)}`;
  const counterProfitFormula = `${formatUsdt(
    stage.counterNotionalUsdt,
  )} x ${stage.counterExitMovePct}% = +${formatUsdt(
    stage.estimatedCounterProfitUsdt,
  )}`;
  const usdtLossFormula =
    stopLossUSDT === null || stage.stopLossUSDTEquivalentPct === null
      ? "USDT stop loss disabled"
      : `-${formatUsdt(stopLossUSDT)} / ${formatUsdt(
        stage.estimatedNotionalUsdt,
      )} x 100 = -${stage.stopLossUSDTEquivalentPct}%`;
  const targetZoneLossFormula =
    stage.estimatedTargetZoneLossUsdt === null
      ? "Target-zone stop disabled"
      : `${formatUsdt(stage.estimatedNotionalUsdt)} x ${targetZoneStopLossPct
      }% = -${formatUsdt(stage.estimatedTargetZoneLossUsdt)}`;
  const postAverageStopLoss = stage.postAverageStopLoss;
  const postAverageStopParts = [
    postAverageStopLoss?.maxNetPnlPct &&
      postAverageStopLoss.estimatedPercentLossUsdt !== null
      ? `${postAverageStopLoss.maxNetPnlPct}% = -${formatUsdt(
          postAverageStopLoss.estimatedPercentLossUsdt,
        )}`
      : null,
    postAverageStopLoss?.maxNetPnlUsdt &&
      postAverageStopLoss.usdtEquivalentPct !== null
      ? `-${formatUsdt(
          Math.abs(postAverageStopLoss.maxNetPnlUsdt),
        )} = -${postAverageStopLoss.usdtEquivalentPct}%`
      : null,
  ].filter((part): part is string => Boolean(part));
  const postAverageStopFormula =
    postAverageStopParts.length > 0
      ? postAverageStopParts.join(" OR ")
      : "Both boundaries disabled for this tier";
  const hasCounterLeg = stage.counterMarginUsdt > 0;
  const isCounterOnly = entryLegs === "COUNTER";
  const activeLegLabel = isCounterOnly ? "COUNTER LEG" : "MAIN LEG";
  const activeLegName = isCounterOnly ? "counter" : "main";
  const netUsdtStopLossIsFirst = stage.firstStopLoss?.type === "NET_USDT";
  const hardStopLossIsFirst =
    stage.firstStopLoss?.type === "HARD_STOP_PERCENT";
  const postAverageStopLossIsFirst =
    stage.firstStopLoss?.type === "POST_AVERAGE";
  const netUsdtStopLossCalculation = netUsdtStopLossIsFirst && (
    <PreviewCalculation
      color="error.dark"
      detail="backtest and runtime evaluate this per-leg net USDT stop before the later percentage hard SL"
      formula={usdtLossFormula}
      label={`Maximum loss at net USDT stop (${formatUsdt(stopLossUSDT ?? 0)})`}
    />
  );

  return (
    <Box sx={{ mb: 1.5 }}>
      <Typography fontWeight={700} variant="body2">
        Stage {stage.stage}
        {stage.averagingStepsUsed === 0
          ? " - Entry only"
          : ` - After averaging ${stage.averagingStepsUsed}`}
      </Typography>
      <Box
        sx={{
          columnGap: 1,
          display: "grid",
          gridTemplateColumns: {
            xs: "minmax(0, 1fr)",
            sm: hasCounterLeg
              ? "repeat(2, minmax(0, 1fr))"
              : "minmax(0, 1fr)",
          },
          mt: 1,
          rowGap: 1,
        }}
      >
        <StageLegGroup
          label={activeLegLabel}
          role={isCounterOnly ? "counter" : "main"}
          testId={isCounterOnly ? "counter-leg-stage" : "main-leg-stage"}
          wide={!hasCounterLeg}
        >
          <PreviewCalculation
            detail={`entry margin + averaging margins used by the ${activeLegName} leg`}
            formula={marginFormula}
            label="Cumulative margin"
          />
          <PreviewCalculation
            detail={`cumulative ${activeLegName} margin x leverage`}
            formula={notionalFormula}
            label="Notional"
          />
          <PreviewCalculation
            color="success.main"
            detail={
              bothDirection
                ? `${activeLegName} notional x take-profit percent; traditional TP or StopLoss+ becomes eligible after price moves VOLATILITY_THRESHOLD favorably from the latest vPoint`
                : `${activeLegName} notional x take-profit percent`
            }
            formula={profitFormula}
            label={`${bothDirection ? "Profit at forming-vPoint TP exception" : "Profit at TP"} (${takeProfitPct}%)`}
          />
          <PreviewCalculation
            color={
              stage.estimatedLossUsdt === null
                ? "text.secondary"
                : "error.main"
            }
            detail={
              stage.estimatedLossUsdt === null
                ? "No stop-loss estimate"
                : `${activeLegName} notional x stop-loss percent`
            }
            formula={lossFormula}
            label={
              stopLossPct === null
                ? "Loss at SL"
                : `Loss at SL (${stopLossPct}%)`
            }
          />
          <PreviewCalculation
            color={
              stage.estimatedTargetZoneLossUsdt === null
                ? "text.secondary"
                : "warning.dark"
            }
            detail={
              stage.estimatedTargetZoneLossUsdt === null
                ? "Volatility target stop loss is disabled"
                : "fee-adjusted threshold after a non-zero vPoint returns to level zero"
            }
            formula={targetZoneLossFormula}
            label={
              targetZoneStopLossPct === null
                ? "Loss at volatility target SL"
                : `Loss at volatility target SL (${targetZoneStopLossPct}%)`
            }
          />
          {postAverageStopLoss && (
            <PreviewCalculation
              color={
                postAverageStopParts.length > 0
                  ? "error.dark"
                  : "text.secondary"
              }
              detail="after this many completed averages, runtime and backtest exit when either active fee-adjusted net PnL boundary is reached; 0 disables that boundary"
              formula={postAverageStopFormula}
              label={`Post-average stop after ${stage.averagingStepsUsed} average${
                stage.averagingStepsUsed === 1 ? "" : "s"
              }`}
            />
          )}
        </StageLegGroup>

        {hasCounterLeg && (
          <StageLegGroup
            label="COUNTER LEG"
            role="counter"
            testId="counter-leg-stage"
          >
            <PreviewCalculation
              detail="counter leg keeps its original entry margin and does not average along this main-leg path"
              formula={formatUsdt(stage.counterMarginUsdt)}
              label="Fixed margin"
            />
            <PreviewCalculation
              detail="fixed counter margin x leverage"
              formula={`${formatUsdt(stage.counterMarginUsdt)} x ${leverage}x = ${formatUsdt(stage.counterNotionalUsdt)}`}
              label="Notional"
            />
            <PreviewCalculation
              color="success.main"
              detail="each completed main averaging level approximates one VOLATILITY_THRESHOLD move in the counter's profit direction"
              formula={counterProfitFormula}
              label={`Profit if closed at this stage (${stage.counterExitMovePct}%)`}
            />
          </StageLegGroup>
        )}

        {stage.firstStopLoss && (
          <StageStopOutcome label="FIRST STOP OUTCOME">
            {hardStopLossIsFirst && (
              <PreviewCalculation
                color="error.dark"
                detail={`the traditional percentage hard SL closes the ${activeLegName.toUpperCase()} leg without closing another role`}
                formula={lossFormula}
                label={`${activeLegName.toUpperCase()} exits at hard SL`}
              />
            )}
            {netUsdtStopLossIsFirst && netUsdtStopLossCalculation}
            {postAverageStopLossIsFirst && (
              <PreviewCalculation
                color="error.dark"
                detail={`this is the earliest configured loss boundary at this stage and closes the ${activeLegName.toUpperCase()} leg`}
                formula={postAverageStopFormula}
                label={`${activeLegName.toUpperCase()} exits at post-average stop`}
              />
            )}
          </StageStopOutcome>
        )}
      </Box>
    </Box>
  );
}

export default function TradingLivePreview({
  allowSpendableAssumption = false,
  config,
  dashboardState,
  sticky = false,
}: {
  allowSpendableAssumption?: boolean;
  config: TradingLivePreviewConfig;
  dashboardState: SlowTradingDashboardState;
  sticky?: boolean;
}) {
  const currentSpendableUsdt = Math.max(
    0,
    dashboardState.balances.spendableQuoteAsset,
  );
  const [spendableAssumptionInput, setSpendableAssumptionInput] = useState(
    String(currentSpendableUsdt),
  );
  useEffect(() => {
    setSpendableAssumptionInput(String(currentSpendableUsdt));
  }, [currentSpendableUsdt]);

  const preview = buildTradingLivePreview({
    config,
    dashboardState,
    spendableAssumptionUsdt: parseSpendableAssumption(
      spendableAssumptionInput,
    ),
  });
  const entryPartsUsdt = [
    preview.entryMarginUsdt,
    ...preview.reserveStepsUsdt,
  ];
  const perLegBudgetFormula = entryPartsUsdt.map(formatUsdt).join(" + ");
  const workerBudgetFormula =
    preview.workerLegs === 2
      ? `2 legs x (${perLegBudgetFormula}) = ${formatUsdt(
        preview.workerCostUsdt,
      )}`
      : `${perLegBudgetFormula} = ${formatUsdt(preview.workerCostUsdt)}`;
  const bailoutCandidateAmounts = [
    ...preview.bailoutCandidates.map((candidate) => candidate.marginUsdt),
    ...(preview.projectedBailoutUsdt > 0
      ? [preview.projectedBailoutUsdt]
      : []),
  ];
  const bailoutFormula =
    bailoutCandidateAmounts.length > 0
      ? `max(${bailoutCandidateAmounts
        .map(formatUsdt)
        .join(", ")}) = ${formatUsdt(preview.bailoutBufferUsdt)}`
      : `No UNRESERVED steps = ${formatUsdt(0)}`;
  const projectedBailoutFormula =
    preview.projectedBailoutMultiplier === null
      ? formatUsdt(preview.projectedBailoutUsdt)
      : `(${preview.projectedBailoutPartsUsdt
        .map(formatUsdt)
        .join(" + ")}) x ${preview.projectedBailoutMultiplier} = ${formatUsdt(
          preview.projectedBailoutUsdt,
        )}`;
  const balanceWorkerCapacityFormula = `floor(${formatUsdt(
    preview.entryBudgetUsdt,
  )} / ${formatUsdt(
    preview.workerCostUsdt,
  )}) = ${preview.balanceAvailableWorkers}`;
  const workerCapacityFormula =
    preview.remainingPositionSlots === null
      ? balanceWorkerCapacityFormula
      : `min(${preview.balanceAvailableWorkers}, ${preview.remainingPositionSlots} position slots) = ${preview.availableWorkers}`;
  const spendableAfterOneWorkerUsdt = Math.max(
    0,
    preview.spendableUsdt - preview.workerCostUsdt,
  );
  const firstWorkerAllowed =
    preview.availableWorkers > 0 &&
    spendableAfterOneWorkerUsdt >= preview.bailoutBufferUsdt;

  return (
    <Paper
      data-testid="trading-live-preview"
      variant="outlined"
      sx={{
        alignSelf: "start",
        borderRadius: 1,
        p: 2,
        position: sticky ? { md: "sticky" } : undefined,
        top: sticky ? { md: 16 } : undefined,
        width: "100%",
      }}
    >
      <Stack gap={1.5}>
        <Box
          sx={{
            alignItems: "center",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <Typography fontWeight={700} variant="subtitle1">
            Live Preview
          </Typography>
          <Tooltip
            arrow
            title={`Uses the current spendable balance and open positions with the ${allowSpendableAssumption ? "unsaved" : "saved"
              } Trading settings. Coin-specific liquidity limits and final exchange fees are applied during execution.`}
          >
            <InfoOutlinedIcon
              aria-label="About live trading preview"
              color="action"
              fontSize="small"
            />
          </Tooltip>
        </Box>

        <Box>
          <Stack alignItems="center" direction="row" gap={0.75} mb={1}>
            <LoginIcon color="primary" fontSize="small" />
            <Typography fontWeight={700} variant="body2">
              Entry
            </Typography>
          </Stack>
          <Stack gap={0.75}>
            <PreviewMetric
              label="Current spendable"
              value={formatUsdt(currentSpendableUsdt)}
            />
            <PreviewMetric
              color={
                preview.maxOpenPositions > 0 &&
                  preview.currentOpenPositions >= preview.maxOpenPositions
                  ? "error.main"
                  : undefined
              }
              label="Max open positions"
              value={
                preview.maxOpenPositions > 0
                  ? `${preview.currentOpenPositions} / ${preview.maxOpenPositions}`
                  : "Disabled"
              }
              valueTooltip={
                preview.maxOpenPositions > 0
                  ? "Current open positions / configured maximum"
                  : "0 disables the maximum-open-positions entry guard"
              }
            />
            {allowSpendableAssumption && (
              <TextField
                fullWidth
                label="Spendable assumption"
                size="small"
                type="number"
                value={spendableAssumptionInput}
                onChange={(event) =>
                  setSpendableAssumptionInput(event.target.value)
                }
                slotProps={{
                  htmlInput: {
                    inputMode: "decimal",
                    min: 0,
                    step: "0.01",
                  },
                }}
              />
            )}
            <Box data-testid="bailout-buffer-preview" sx={{ mb: 0.5 }}>
              <Stack alignItems="center" direction="row" gap={0.25}>
                <Typography color="text.secondary" variant="body2">
                  Bailout buffer
                </Typography>
                <ReadMoreDialogButton
                  dialogTitle="Bailout Buffer Mechanism"
                  tooltip="Read more about the bailout buffer"
                >
                  <Box sx={{ display: "grid", gap: 2 }}>
                    <Typography variant="body2">
                      The bailout buffer is shared account spendable balance.
                      It is not assigned to, or locked for, one specific open
                      position.
                    </Typography>

                    <Box>
                      <Typography fontWeight={700} gutterBottom variant="body2">
                        How the buffer is selected
                      </Typography>
                      <Typography color="text.secondary" variant="body2">
                        SLOW finds the largest UNRESERVED averaging step from
                        every open position and the projected new worker. It
                        preserves only the largest candidate, not the sum of
                        every candidate.
                      </Typography>
                    </Box>

                    <Box>
                      <Typography fontWeight={700} gutterBottom variant="body2">
                        How it blocks entries
                      </Typography>
                      <Typography color="text.secondary" variant="body2">
                        Before entry, SLOW subtracts the entry margin and its
                        reserved averaging steps from spendable balance. The
                        entry is allowed only when the amount left is at least
                        the shared bailout buffer.
                      </Typography>
                    </Box>

                    <Box>
                      <Typography fontWeight={700} gutterBottom variant="body2">
                        Current preview
                      </Typography>
                      <Typography
                        sx={{ fontVariantNumeric: "tabular-nums" }}
                        variant="body2"
                      >
                        {formatUsdt(preview.spendableUsdt)} -{" "}
                        {formatUsdt(preview.workerCostUsdt)} ={" "}
                        {formatUsdt(spendableAfterOneWorkerUsdt)}
                      </Typography>
                      <Typography
                        color={
                          firstWorkerAllowed ? "success.main" : "error.main"
                        }
                        fontWeight={700}
                        sx={{ fontVariantNumeric: "tabular-nums" }}
                        variant="body2"
                      >
                        {formatUsdt(spendableAfterOneWorkerUsdt)}{" "}
                        {firstWorkerAllowed ? ">=" : "<"}{" "}
                        {formatUsdt(preview.bailoutBufferUsdt)}: entry{" "}
                        {firstWorkerAllowed ? "allowed" : "blocked"}
                      </Typography>
                    </Box>

                    <Box>
                      <Typography fontWeight={700} gutterBottom variant="body2">
                        When it is used
                      </Typography>
                      <Typography color="text.secondary" variant="body2">
                        Any eligible open position can spend this balance when
                        its UNRESERVED averaging step triggers. Afterward, SLOW
                        recalculates the shared buffer from the updated balance
                        and watch states.
                      </Typography>
                    </Box>
                  </Box>
                </ReadMoreDialogButton>
              </Stack>

              <Box
                data-testid="bailout-buffer-candidates"
                sx={{
                  borderColor: "divider",
                  borderLeftStyle: "solid",
                  borderLeftWidth: 2,
                  ml: 0.5,
                  mt: 0.5,
                  pl: 1.25,
                }}
              >
                <Typography
                  color="text.secondary"
                  fontWeight={700}
                  variant="caption"
                >
                  Candidates
                </Typography>

                {preview.bailoutCandidates.length > 0 && (
                  <Stack gap={0.25} mb={0.75} mt={0.5}>
                    <Typography color="text.secondary" variant="caption">
                      Open positions
                    </Typography>
                    {preview.bailoutCandidates.map((candidate, index) => (
                      <PreviewMetric
                        key={`${candidate.symbol}-${candidate.level}-${index}`}
                        label={`${candidate.symbol}${candidate.level === null
                            ? ""
                            : ` level ${candidate.level}`
                          }`}
                        value={formatUsdt(candidate.marginUsdt)}
                        valueTooltip="UNRESERVED"
                      />
                    ))}
                  </Stack>
                )}

                {preview.projectedBailoutUsdt > 0 && (
                  <Box sx={{ mt: 0.5 }}>
                    <PreviewCalculation
                      detail="entry margin + all earlier averaging margins, multiplied by the reserve multiplier"
                      formula={projectedBailoutFormula}
                      label={`Projected new worker${preview.projectedBailoutLevel === null
                          ? ""
                          : ` level ${preview.projectedBailoutLevel}`
                        }`}
                    />
                  </Box>
                )}

                <Box
                  sx={{
                    borderColor: "divider",
                    borderTopStyle: "dashed",
                    borderTopWidth: 1,
                    mt: 0.5,
                    pt: 0.75,
                  }}
                >
                  <PreviewCalculation
                    detail="largest UNRESERVED averaging step preserved across open positions and the projected new worker"
                    formula={bailoutFormula}
                    label="Preserved maximum"
                  />
                </Box>
              </Box>
            </Box>
            {preview.bailoutBufferUsdt > 0 && (
              <PreviewMetric
                label="Spendable after preserving bailout"
                value={formatUsdt(preview.entryBudgetUsdt)}
              />
            )}
            {preview.bailoutBufferUsdt === 0 && (
              <PreviewMetric
                label="Available for new workers"
                value={formatUsdt(preview.entryBudgetUsdt)}
              />
            )}
            <PreviewCalculation
              detail={
                preview.workerLegs === 2
                  ? "main and counter initial entry plus each leg's rolling averaging reserve"
                  : `${preview.entryLegs.toLowerCase()} entry + its rolling averaging reserve`
              }
              formula={workerBudgetFormula}
              label={
                preview.workerLegs === 2
                  ? "Budget per worker pair"
                  : "Budget per worker"
              }
            />
            <PreviewCalculation
              detail={
                preview.remainingPositionSlots === null
                  ? "floor(available for new workers / worker budget)"
                  : "lower of balance-funded workers and remaining open-position slots"
              }
              formula={workerCapacityFormula}
              label="Available workers"
            />
          </Stack>
        </Box>

        <Divider sx={{ my: 2 }} />

        <AveragingSimulationPreview simulation={preview.averagingSimulation} />

        <Divider sx={{ my: 2 }} />

        <Box>
          <Stack alignItems="center" direction="row" gap={0.75} mb={1}>
            <LogoutIcon color="action" fontSize="small" />
            <Typography fontWeight={700} variant="body2">
              Exit per worker
            </Typography>
          </Stack>
          <Stack gap={0.75}>
            <PreviewMetric label="Preview leverage" value={`${preview.leverage}x`} />
            <ExitThresholdChart
              stopLossPct={preview.stopLossPct}
              stopLossPlusEnabled={Boolean(
                config.modelConfig.useStopLossPlus,
              )}
              takeProfitPct={preview.takeProfitPct}
              targetZoneStopLossPct={preview.targetZoneStopLossPct}
              triggerPct={config.modelConfig.stopLossPlusTrigger ?? 1}
            />
            {preview.exitStages.map((stage) => (
              <ExitStagePreview
                bothDirection={config.openDirection === "BOTH"}
                entryLegs={preview.entryLegs}
                key={stage.stage}
                leverage={preview.leverage}
                stage={stage}
                stopLossPct={preview.stopLossPct}
                stopLossUSDT={preview.stopLossUSDT}
                takeProfitPct={preview.takeProfitPct}
                targetZoneStopLossPct={preview.targetZoneStopLossPct}
              />
            ))}
            {config.adaptiveAveraging?.enabled && (
              <Typography color="text.secondary" variant="caption">
                Adaptive averaging may increase a stage margin up to{" "}
                {config.adaptiveAveraging.maxMultiplier}x to target at least{" "}
                {config.adaptiveAveraging.minProjectedProfitPct}% projected
                profit.
              </Typography>
            )}
          </Stack>
        </Box>
      </Stack>
    </Paper>
  );
}
