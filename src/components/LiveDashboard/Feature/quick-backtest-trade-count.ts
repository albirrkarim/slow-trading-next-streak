import type { SlowQuickBacktestResult } from "@/lib/slowTrading";

export interface QuickBacktestTradeCountRow {
  [key: string]: number | string;
  count: number;
  symbol: string;
}

/**
 * Counts closed Quick Backtest trade-history rows by symbol for dashboard charts.
 */
export function buildQuickBacktestTradeCountBySymbol(
  history: SlowQuickBacktestResult["tradeHistory"],
): QuickBacktestTradeCountRow[] {
  const countBySymbol = new Map<string, number>();

  const countedWorkers = new Set<string>();

  for (const [index, trade] of history.entries()) {
    const symbol = String(trade.symbol || "")
      .trim()
      .toUpperCase();
    if (!symbol) {
      continue;
    }

    const entryId = String(trade.opened?.vPoint?.id ?? "").trim();
    const entryTime = Number(trade.opened?.t);
    const workerId =
      entryId && Number.isFinite(entryTime)
        ? `${symbol}:${entryId}:${entryTime}`
        : `${symbol}:ROW:${index}`;
    if (countedWorkers.has(workerId)) {
      continue;
    }
    countedWorkers.add(workerId);

    countBySymbol.set(symbol, (countBySymbol.get(symbol) ?? 0) + 1);
  }

  return [...countBySymbol.entries()]
    .map(([symbol, count]) => ({ count, symbol }))
    .sort(
      (left, right) =>
        right.count - left.count || left.symbol.localeCompare(right.symbol),
    );
}
