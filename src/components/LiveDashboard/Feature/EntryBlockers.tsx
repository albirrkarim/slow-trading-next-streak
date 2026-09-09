import HeaderMetrics from "@/components/ui/HeaderMetrics";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import RefreshIcon from "@mui/icons-material/Refresh";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import {
  Box,
  Chip,
  CircularProgress,
  IconButton,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import type { EntryDiagnosticsController } from "./useEntryDiagnostics";

export default function EntryBlockers({
  controller,
}: {
  controller: EntryDiagnosticsController;
}) {
  return (
    <HeaderMetrics
      defaultExpanded
      headerCanBeClicked
      rememberExpand="entry-blockers"
      title={
        <Typography fontWeight="bold" variant="body1">
          Entry Decisions
        </Typography>
      }
    >
      {(expanded) =>
        expanded && <EntryBlockersContent controller={controller} />
      }
    </HeaderMetrics>
  );
}

function EntryBlockersContent({
  controller,
}: {
  controller: EntryDiagnosticsController;
}) {
  const { diagnostics, error, generatedAt, loading, refresh } = controller;

  return (
    <Box sx={{ mt: 0.5 }}>
      <Box
        sx={{
          alignItems: "center",
          display: "flex",
          justifyContent: "space-between",
          mb: 0.75,
        }}
      >
        <Typography color="text.secondary" variant="caption">
          Current entry status for configured coins
          {generatedAt > 0 &&
            ` · checked ${new Date(generatedAt).toLocaleTimeString()}`}
        </Typography>
        <Tooltip title="Refresh entry decisions">
          <span>
            <IconButton
              aria-label="Refresh entry decisions"
              disabled={loading}
              onClick={(event) => {
                event.stopPropagation();
                void refresh();
              }}
              size="small"
            >
              {loading ? (
                <CircularProgress size={16} />
              ) : (
                <RefreshIcon fontSize="small" />
              )}
            </IconButton>
          </span>
        </Tooltip>
      </Box>

      {error && (
        <Paper
          sx={{ color: "error.main", p: 1.25 }}
          variant="outlined"
        >
          <Typography variant="body2">{error}</Typography>
        </Paper>
      )}

      {!error && loading && diagnostics.length === 0 && (
        <Paper sx={{ p: 1.5, textAlign: "center" }} variant="outlined">
          <Typography color="text.secondary" variant="body2">
            Evaluating current entry decisions...
          </Typography>
        </Paper>
      )}

      {!error && !loading && diagnostics.length === 0 && (
        <Paper sx={{ p: 1.5, textAlign: "center" }} variant="outlined">
          <Typography color="text.secondary" variant="body2">
            No configured coins are available for entry evaluation.
          </Typography>
        </Paper>
      )}

      {!error && diagnostics.length > 0 && (
        <Stack
          spacing={0.75}
          sx={{ maxHeight: 480, overflowY: "auto", pr: 0.25 }}
        >
          {diagnostics.map((diagnostic) => {
            const ready = diagnostic.status === "ready";
            const sourceLabel =
              diagnostic.source?.scope === "account"
                ? diagnostic.source.accountName
                : "Shared guard";
            return (
              <Paper
                key={`${diagnostic.symbol}-${diagnostic.role ?? "PAIR"}-${diagnostic.source?.scope === "account" ? diagnostic.source.accountSlug : "SHARED"}-${diagnostic.pointId ?? diagnostic.code}`}
                sx={{
                  borderLeft: 3,
                  borderLeftColor: ready ? "success.main" : "warning.main",
                  p: 1,
                }}
                variant="outlined"
              >
                <Box
                  sx={{
                    alignItems: "center",
                    display: "flex",
                    gap: 0.75,
                    mb: 0.5,
                  }}
                >
                  {ready ? (
                    <CheckCircleOutlineIcon
                      color="success"
                      fontSize="small"
                    />
                  ) : (
                    <WarningAmberIcon color="warning" fontSize="small" />
                  )}
                  <Typography fontWeight={700} variant="body2">
                    {diagnostic.symbol}
                  </Typography>
                  <Typography color="text.secondary" variant="caption">
                    {sourceLabel}
                  </Typography>
                  {diagnostic.role && (
                    <Chip
                      label={diagnostic.role}
                      size="small"
                      sx={{ height: 20 }}
                      variant="outlined"
                    />
                  )}
                  {typeof diagnostic.level === "number" && (
                    <Typography color="text.secondary" variant="caption">
                      Level {diagnostic.level}
                    </Typography>
                  )}
                  <Chip
                    color={ready ? "success" : "warning"}
                    label={ready ? "Ready" : "Blocked"}
                    size="small"
                    sx={{ height: 20, ml: "auto" }}
                    variant="outlined"
                  />
                </Box>
                <Typography color="text.secondary" variant="caption">
                  {diagnostic.reason}
                </Typography>
              </Paper>
            );
          })}
        </Stack>
      )}
    </Box>
  );
}
