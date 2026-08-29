import { buildQuickBacktestTradeCountBySymbol } from "@/components/LiveDashboard/Feature/quick-backtest-trade-count";

describe("Quick Backtest trade count chart", () => {
  it("counts trade history rows by symbol for the pie chart", () => {
    expect(
      buildQuickBacktestTradeCountBySymbol([
        { symbol: "sui" },
        { symbol: "AAVE" },
        { symbol: "SUI" },
        { symbol: "  " },
        { symbol: "BTC" },
        { symbol: "AAVE" },
        { symbol: "SUI" },
      ] as any),
    ).toEqual([
      { count: 3, symbol: "SUI" },
      { count: 2, symbol: "AAVE" },
      { count: 1, symbol: "BTC" },
    ]);
  });

  it("counts paired MAIN/COUNTER history rows as one coin trade", () => {
    const opened = { t: 1, vPoint: { id: "PAIR_1", lvl: -2 } };

    // BOTH:ENTRY_BOTH_DIRECTION
    expect(
      buildQuickBacktestTradeCountBySymbol([
        { symbol: "SUI", role: "MAIN", opened },
        { symbol: "SUI", role: "COUNTER", opened },
      ] as any),
    ).toEqual([{ count: 1, symbol: "SUI" }]);
  });
});
