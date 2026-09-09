"use client";

import HeaderMetrics from "@/components/ui/HeaderMetrics";
import type { SlowTradingEntryDiagnostic } from "@/lib/slowTrading/client";
import type { PositionRole } from "@/lib/trading/models";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import { Box, Chip, Stack, Typography } from "@mui/material";
import moment from "moment-timezone";

interface MissingPositionDecisionProps {
  captureEntryLastRunAt?: number;
  diagnostics?: SlowTradingEntryDiagnostic[];
  error?: string;
  generatedAt?: number;
  loading?: boolean;
  role: PositionRole;
  symbol: string;
  title: string;
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
  const ready = diagnostic.status === "ready";
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
        {ready ? (
          <CheckCircleOutlineIcon color="success" sx={{ fontSize: 17 }} />
        ) : (
          <WarningAmberIcon color="warning" sx={{ fontSize: 17 }} />
        )}
        <Typography fontWeight={700} variant="caption">
          {label}
        </Typography>
        <Chip
          color={ready ? "success" : "warning"}
          label={ready ? "Ready" : "Blocked"}
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
  captureEntryLastRunAt = 0,
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
  const awaitsNextCaptureEntry =
    visibleDecisions.some((diagnostic) => diagnostic.status === "ready") &&
    generatedAt > captureEntryLastRunAt;
  const timingMeta = [
    generatedAt > 0
      ? `Decision checked ${moment(generatedAt).format("D MMM HH:mm:ss")}`
      : "Decision check time unavailable",
    captureEntryLastRunAt > 0
      ? `Capture Entry completed ${moment(captureEntryLastRunAt).format("D MMM HH:mm:ss")}`
      : "Capture Entry has never completed",
  ].join(" · ");

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
            {awaitsNextCaptureEntry && (
              <Typography
                color="success.main"
                sx={{ display: "block", mt: 0.75 }}
                variant="caption"
              >
                Ready after the last Capture Entry pass; execution has not
                checked this state yet.
              </Typography>
            )}
            <Typography
              color="text.disabled"
              sx={{ display: "block", mt: 0.75 }}
              variant="caption"
            >
              {timingMeta}
            </Typography>
          </Box>
        )
      }
    </HeaderMetrics>
  );
}
