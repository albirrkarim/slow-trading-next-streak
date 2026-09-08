import type { TradingReturn } from "@/lib/trading";
import type { PositionRole } from "@/lib/trading/models";
import type { SlowTradingSkippedEntrySignal } from "../shared";
import type { SlowTradingStageRunCheck } from "../types";

const MAX_CHECKS = 100;
const MAX_MESSAGE_LENGTH = 500;

function normalizeMessage(message: unknown): string {
  return String(message || "No execution message")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH);
}

/** Builds one compact navbar-debug result from an execution report. */
function buildExecution(params: {
  report: TradingReturn;
  role?: PositionRole;
  symbol: string;
}): SlowTradingStageRunCheck {
  const action =
    params.report.tradingDetail?.action ?? params.report.action ?? "HOLD";
  return {
    s: params.symbol.trim().toUpperCase(),
    r: params.role,
    a: action,
    ok: action === "BUY" || action === "SELL" || action === "SHORT",
    m: normalizeMessage(params.report.message),
  };
}

/** Merges execution reports and skipped-entry reasons for the stage report. */
function merge(params: {
  execution: SlowTradingStageRunCheck[];
  skippedEntries: SlowTradingSkippedEntrySignal[];
}): SlowTradingStageRunCheck[] {
  const checks = [...params.execution];
  for (const skipped of params.skippedEntries) {
    const check: SlowTradingStageRunCheck = {
      s: skipped.symbol.trim().toUpperCase(),
      r: skipped.role,
      a: "BLOCKED",
      ok: false,
      m: normalizeMessage(skipped.reason),
    };
    if (
      !checks.some(
        (candidate) =>
          candidate.s === check.s &&
          candidate.r === check.r &&
          candidate.m === check.m,
      )
    ) {
      checks.push(check);
    }
  }
  return checks.slice(-MAX_CHECKS);
}

const slowTradingCycleChecks = {
  build: {
    execution: buildExecution,
  },
  merge,
} as const;

export default slowTradingCycleChecks;
