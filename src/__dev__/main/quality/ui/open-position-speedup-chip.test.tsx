/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import OpenPositionItem from "@/components/LiveDashboard/Feature/OpenPositionItem";
import { createTestPosition } from "../fixtures/position";

vi.mock("@/components/ui/HeaderMetrics", () => ({
  default: ({
    children,
    title,
  }: {
    children?: (expanded: boolean) => React.ReactNode;
    title: React.ReactNode;
  }) => (
    <div>
      {title}
      {children?.(true)}
    </div>
  ),
}));

vi.mock("@/components/LiveDashboard/Feature/OpenPositionLevelSequence", () => ({
  default: () => null,
}));

vi.mock("@/components/dev/Coins/CoinTagChip", () => ({
  default: () => null,
}));

describe("OpenPositionItem", () => {
  it("sends the clicked counter role when manually closing a position", () => {
    const onExit = vi.fn().mockResolvedValue(undefined);
    const position = createTestPosition({
      direction: "SHORT",
      role: "COUNTER",
      symbol: "SUI",
    });

    render(
      <OpenPositionItem
        availableTags={[]}
        coinDescription=""
        coinTags={[]}
        config={{ watchReservePctAlloc: 2 } as any}
        exchangeType="binance"
        onCoinDescriptionChange={vi.fn()}
        onCoinTagsChange={vi.fn()}
        onExit={onExit}
        pnlContributionShare={1}
        position={{ ...position, mode: "live" }}
        spendableQuoteAsset={100}
        tagColors={{}}
        tagDescriptions={{}}
        volatilityPoints={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close Position" }));

    // PROD:MANUAL_EXIT_POSITION_ROLE
    expect(onExit).toHaveBeenCalledWith("SUI", "COUNTER");
  });

  it("shows the latest successful monitoring time for Speedup positions", async () => {
    const lastUpdated = Date.UTC(2026, 0, 1, 0, 5);
    const position = createTestPosition({
      direction: "LONG",
      entryPrice: 10,
      entryTime: Date.UTC(2026, 0, 1),
      executionMode: "live",
      notionalUsdt: 10,
      quantity: 1,
      symbol: "SUI",
    });
    position.lastMonitoringStage = {
      stage: "speedup",
      lastUpdated,
      reason: "positive PnL threshold",
    };

    render(
      <OpenPositionItem
        availableTags={[]}
        coinDescription=""
        coinTags={[]}
        config={{ watchReservePctAlloc: 2 } as any}
        exchangeType="binance"
        onCoinDescriptionChange={vi.fn()}
        onCoinTagsChange={vi.fn()}
        pnlContributionShare={1}
        position={{ ...position, mode: "live" }}
        spendableQuoteAsset={100}
        tagColors={{}}
        tagDescriptions={{}}
        volatilityPoints={[]}
      />,
    );

    // PROD:SPEEDUP_STAGE
    const chip = screen.getByLabelText("Speedup monitoring stage");
    expect(screen.getByTestId("SpeedIcon")).toBeTruthy();
    expect(screen.queryByText("SPEEDUP")).toBeNull();
    fireEvent.mouseOver(chip);
    expect(
      await screen.findByText(
        /Speedup monitoring stage: positive PnL threshold\. Last updated:/,
      ),
    ).toBeTruthy();
  });

  it("does not show Speedup for a Standard Monitoring position", () => {
    const position = createTestPosition({
      direction: "LONG",
      entryPrice: 10,
      entryTime: Date.UTC(2026, 0, 1),
      executionMode: "live",
      notionalUsdt: 10,
      quantity: 1,
      symbol: "SUI",
    });
    position.pnl.netPct = 10;
    position.lastMonitoringStage = {
      stage: "standard",
      lastUpdated: Date.UTC(2026, 0, 1, 0, 5),
      reason: "No Speedup rule matched",
    };

    render(
      <OpenPositionItem
        availableTags={[]}
        coinDescription=""
        coinTags={[]}
        config={{ watchReservePctAlloc: 2 } as any}
        exchangeType="binance"
        onCoinDescriptionChange={vi.fn()}
        onCoinTagsChange={vi.fn()}
        pnlContributionShare={1}
        position={{ ...position, mode: "live" }}
        spendableQuoteAsset={100}
        tagColors={{}}
        tagDescriptions={{}}
        volatilityPoints={[]}
      />,
    );

    // PROD:STANDARD_MONITORING_STAGE
    expect(screen.queryByLabelText("Speedup monitoring stage")).toBeNull();
  });

  it("shows the persisted Speedup reason without recalculating it", () => {
    const position = createTestPosition({
      direction: "LONG",
      entryPrice: 10,
      executionMode: "live",
      symbol: "SUI",
    });
    position.lastMonitoringStage = {
      stage: "speedup",
      lastUpdated: Date.UTC(2026, 0, 1, 0, 5),
      reason: "post-average target approach",
    };

    render(
      <OpenPositionItem
        availableTags={[]}
        coinDescription=""
        coinTags={[]}
        config={{ watchReservePctAlloc: 2 } as any}
        exchangeType="binance"
        onCoinDescriptionChange={vi.fn()}
        onCoinTagsChange={vi.fn()}
        pnlContributionShare={1}
        position={{ ...position, mode: "live" }}
        spendableQuoteAsset={100}
        tagColors={{}}
        tagDescriptions={{}}
        volatilityPoints={[]}
      />,
    );

    // PROD:SPEEDUP_STAGE
    expect(screen.getByLabelText("Speedup monitoring stage")).toBeTruthy();
  });

  it("ends a closed leg sequence at its recorded exit", () => {
    const position = createTestPosition({
      direction: "LONG",
      entryLevel: 0,
      entryTime: 100,
      executionMode: "sandbox",
      symbol: "MON",
    });
    position.strategy.averaging.steps = [
      { allocationPct: 3, level: -1, marginUsdt: 15, status: "RELEASED" },
      { allocationPct: 3, level: -2, marginUsdt: 60, status: "RELEASED" },
    ];
    position.closed = {
      feeUsdt: 0.02,
      message: "Closed at take profit",
      price: 101,
      reason: "STOP_LOSS_PLUS_TP",
      t: 200,
      vPoint: { id: position.opened.vPoint.id, lvl: 0 },
    };
    position.vPoints = [];

    render(
      <OpenPositionItem
        availableTags={[]}
        coinDescription=""
        coinTags={[]}
        config={{ watchReservePctAlloc: 3 } as any}
        currentVolatilityLevel={-1}
        exchangeType="binance"
        onCoinDescriptionChange={vi.fn()}
        onCoinTagsChange={vi.fn()}
        pnlContributionShare={1}
        position={{ ...position, mode: "sandbox" }}
        spendableQuoteAsset={100}
        tagColors={{}}
        tagDescriptions={{}}
        volatilityPoints={[]}
      />,
    );

    expect(screen.getByText("Closed")).toBeTruthy();
    expect(screen.getByText("L0 EXIT")).toBeTruthy();
    expect(screen.queryByText("L-1")).toBeNull();
    expect(screen.queryByText("L-2")).toBeNull();
  });
});
