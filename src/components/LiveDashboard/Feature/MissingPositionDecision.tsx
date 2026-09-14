"use client";

import HeaderMetrics from "@/components/ui/HeaderMetrics";
import slowTradingClient, {
  type SlowTradingEntryDiagnostic,
} from "@/lib/slowTrading/client";
import type { PositionRole } from "@/lib/trading/models";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import { Box, Chip, Divider, Stack, Tooltip, Typography } from "@mui/material";
import moment from "moment-timezone";

interface MissingPositionDecisionProps {
  captureEntryIntervalMinutes?: number;
  captureEntryLastRunAt?: number;
  currentTimeMs: number;
  diagnostics?: SlowTradingEntryDiagnostic[];
  error?: string;
  generatedAt?: number;
  loading?: boolean;
  role: PositionRole;
  symbol: string;
  title: string;
}

const MINUTE_MS = 60 * 1000;

/** Describes the next Capture Entry pass from its persisted completion cadence. */
function describeNextCaptureEntry(params: {
  currentTimeMs: number;
  intervalMinutes?: number;
  lastRunAt: number;
}) {
  const intervalMinutes = slowTradingClient.stages.interval.normalizeMinutes(
    params.intervalMinutes,
    slowTradingClient.stages.interval.defaults["capture-entry"],
  );
  const nextRunAt = params.lastRunAt + intervalMinutes * MINUTE_MS;
  const nextRunTime = moment(nextRunAt)
    .tz("Asia/Jakarta")
    .format("HH:mm");
  const remainingMs = nextRunAt - params.currentTimeMs;

  if (remainingMs <= 0) {
    return `Next Capture Entry cycle is due now (scheduled for ${nextRunTime} WIB).`;
  }

  const remainingMinutes = Math.ceil(remainingMs / MINUTE_MS);
  return (
    `Next Capture Entry cycle in ${remainingMinutes} ` +
    `minute${remainingMinutes === 1 ? "" : "s"} at ${nextRunTime} WIB.`
  );
}

/** Selects the role-specific decision, falling back to a pair-level decision. */
function findDecision(
  diagnostics: SlowTradingEntryDiagnostic[],
  symbol: string,
  role: PositionRole,
) {
  return (
    diagnostics.find(
      (diagnostic) =>
        diagnostic.symbol.trim().toUpperCase() === symbol &&
        diagnostic.role === role,
    ) ??
    diagnostics.find(
      (diagnostic) =>
        diagnostic.symbol.trim().toUpperCase() === symbol && !diagnostic.role,
    )
  );
}

function DecisionReason({
  diagnostic,
  label,
}: {
  diagnostic: SlowTradingEntryDiagnostic;
  label: string;
}) {
  // PROD:MULTI_ACCOUNT_ENTRY_DIAGNOSTICS
  if (diagnostic.code === "ACCOUNT_ENTRY_LEG_DISABLED") {
    return (
      <Box
        sx={{
          alignItems: "center",
          borderBottom: 1,
          borderColor: "divider",
          display: "flex",
          gap: 0.75,
          pb: 1,
          "&:last-child": { borderBottom: 0, pb: 0 },
        }}
      >
        <Typography fontWeight={700} variant="caption">
          {label}
        </Typography>
        <Tooltip
          arrow
          describeChild
          placement="top"
          title={diagnostic.reason}
        >
          <Chip
            label="Disabled"
            size="small"
            sx={{ cursor: "help", height: 19, ml: "auto" }}
            tabIndex={0}
            variant="outlined"
          />
        </Tooltip>
      </Box>
    );
  }

  const ready = diagnostic.status === "ready";
  if (ready) {
    return (
      <Box
        sx={{
          alignItems: "center",
          borderBottom: 1,
          borderColor: "divider",
          display: "flex",
          gap: 0.75,
          pb: 1,
          "&:last-child": { borderBottom: 0, pb: 0 },
        }}
      >
        <CheckCircleOutlineIcon color="success" sx={{ fontSize: 17 }} />
        <Typography fontWeight={700} variant="caption">
          {label}
        </Typography>
        <Tooltip
          arrow
          describeChild
          placement="top"
          title={
            <Stack spacing={0.25}>
              <Typography variant="body2">{diagnostic.reason}</Typography>
              <Typography color="inherit" sx={{ opacity: 0.7 }} variant="caption">
                {diagnostic.code}
              </Typography>
            </Stack>
          }
        >
          <Chip
            color="success"
            label="Ready"
            size="small"
            sx={{ cursor: "help", height: 19, ml: "auto" }}
            tabIndex={0}
            variant="outlined"
          />
        </Tooltip>
      </Box>
    );
  }

  const meta = [
    diagnostic.code,
    diagnostic.pointId,
    typeof diagnostic.level === "number"
      ? `Level ${diagnostic.level}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Box
      sx={{
        borderBottom: 1,
        borderColor: "divider",
        pb: 1,
        "&:last-child": { borderBottom: 0, pb: 0 },
      }}
    >
      <Box sx={{ alignItems: "center", display: "flex", gap: 0.75, mb: 0.4 }}>
        <WarningAmberIcon color="warning" sx={{ fontSize: 17 }} />
        <Typography fontWeight={700} variant="caption">
          {label}
        </Typography>
        <Chip
          color="warning"
          label="Blocked"
          size="small"
          sx={{ height: 19, ml: "auto" }}
          variant="outlined"
        />
      </Box>
      <Typography color="text.secondary" variant="body2">
        {diagnostic.reason}
      </Typography>
      <Typography
        color="text.disabled"
        sx={{ display: "block", mt: 0.35 }}
        variant="caption"
      >
        {meta}
      </Typography>
    </Box>
  );
}

export default function MissingPositionDecision({
  captureEntryIntervalMinutes,
  captureEntryLastRunAt = 0,
  currentTimeMs,
  diagnostics = [],
  error = "",
  generatedAt = 0,
  loading = false,
  role,
  symbol: rawSymbol,
  title,
}: MissingPositionDecisionProps) {
  const symbol = rawSymbol.trim().toUpperCase();
  const sharedDiagnostics = diagnostics.filter(
    (diagnostic) =>
      diagnostic.source?.scope === "shared" || !diagnostic.source,
  );
  const sharedDecision = findDecision(sharedDiagnostics, symbol, role);
  const accountDecisions = diagnostics.filter(
    (diagnostic) =>
      diagnostic.source?.scope === "account" &&
      diagnostic.symbol.trim().toUpperCase() === symbol &&
      diagnostic.role === role,
  );
  const visibleDecisions = [sharedDecision, ...accountDecisions].filter(
    (diagnostic): diagnostic is SlowTradingEntryDiagnostic =>
      Boolean(diagnostic),
  );
  const readyAccountCount = accountDecisions.filter(
    (diagnostic) => diagnostic.status === "ready",
  ).length;
  const hasDisabledAccountLeg = accountDecisions.some(
    (diagnostic) => diagnostic.code === "ACCOUNT_ENTRY_LEG_DISABLED",
  );
  const ready =
    sharedDecision?.status !== "blocked" &&
    (accountDecisions.length > 0
      ? readyAccountCount > 0
      : sharedDecision?.status === "ready");
  const summaryLabel =
    sharedDecision?.status === "blocked"
      ? "Shared blocked"
      : accountDecisions.length > 0
        ? `${readyAccountCount}/${accountDecisions.length} ready`
        : ready
          ? "Ready"
          : "Blocked";
  const hasReadyEntryDecision =
    accountDecisions.length > 0
      ? readyAccountCount > 0
      : sharedDecision?.status === "ready";
  const awaitsNextCaptureEntry =
    hasReadyEntryDecision && generatedAt > captureEntryLastRunAt;
  const showTiming = !hasDisabledAccountLeg || hasReadyEntryDecision;
  const timingMeta = [
    generatedAt > 0
      ? `Decision checked ${moment(generatedAt).format("D MMM HH:mm:ss")}`
      : "Decision check time unavailable",
    captureEntryLastRunAt > 0
      ? `Capture Entry completed ${moment(captureEntryLastRunAt).format("D MMM HH:mm:ss")}`
      : "Capture Entry has never completed",
  ].join(" · ");
  const nextCaptureEntry =
    awaitsNextCaptureEntry && captureEntryLastRunAt > 0
      ? describeNextCaptureEntry({
          currentTimeMs,
          intervalMinutes: captureEntryIntervalMinutes,
          lastRunAt: captureEntryLastRunAt,
        })
      : "";

  return (
    <HeaderMetrics
      defaultExpanded
      headerSx={{ p: 0.5 }}
      sx={{ border: 1, borderColor: "divider" }}
      title={<Typography fontWeight={700}>{title}</Typography>}
      titleRight={
        visibleDecisions.length > 0 && (
          <Chip
            color={ready ? "success" : "warning"}
            label={summaryLabel}
            size="small"
            variant="outlined"
          />
        )
      }
      toggleLabel={`${title} details`}
    >
      {(expanded) =>
        expanded && (
          <Box sx={{ borderTop: 1, borderColor: "divider", p: 1.5 }}>
            {loading && visibleDecisions.length === 0 && (
              <Typography color="text.secondary" variant="body2">
                Evaluating why {role} is not open for every enabled account...
              </Typography>
            )}
            {error && (
              <Typography color="error.main" role="alert" variant="body2">
                Unable to load the {role} entry reasons: {error}
              </Typography>
            )}
            {!loading && !error && visibleDecisions.length === 0 && (
              <Typography color="text.secondary" variant="body2">
                No current {role} entry decisions are available.
              </Typography>
            )}
            {!error && visibleDecisions.length > 0 && (
              <Stack spacing={1}>
                {sharedDecision && (
                  <DecisionReason
                    diagnostic={sharedDecision}
                    label="Shared guard"
                  />
                )}
                {accountDecisions.map((diagnostic) => (
                  <DecisionReason
                    diagnostic={diagnostic}
                    key={
                      diagnostic.source?.scope === "account"
                        ? diagnostic.source.accountSlug
                        : diagnostic.code
                    }
                    label={
                      diagnostic.source?.scope === "account"
                        ? diagnostic.source.accountName
                        : "Account"
                    }
                  />
                ))}
              </Stack>
            )}
            {showTiming && !error && visibleDecisions.length > 0 && (
              <Divider sx={{ mt: 1 }} />
            )}
            {showTiming && awaitsNextCaptureEntry && (
              <Typography
                color="success.main"
                sx={{ display: "block", mt: 0.75 }}
                variant="caption"
              >
                Ready after the last Capture Entry pass; execution has not
                checked this state yet.
              </Typography>
            )}
            {showTiming && (
              <Typography
                color="text.disabled"
                sx={{ display: "block", mt: 0.75 }}
                variant="caption"
              >
                {timingMeta}
              </Typography>
            )}
            {showTiming && nextCaptureEntry && (
              <Typography
                color="text.secondary"
                sx={{ display: "block", mt: 0.5 }}
                variant="caption"
              >
                {nextCaptureEntry}
              </Typography>
            )}
          </Box>
        )
      }
    </HeaderMetrics>
  );
}
