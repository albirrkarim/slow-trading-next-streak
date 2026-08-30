/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import OpenPositions from "@/components/LiveDashboard/Feature/OpenPositions";
import openPositionPnlContribution from "@/components/LiveDashboard/Feature/open-position-pnl-contribution";
import { createTestPosition } from "../fixtures/position";

vi.mock("@/components/LiveDashboard/Feature/OpenPositionItem", () => ({
  default: ({
    pnlContributionShare,
    position,
  }: {
    pnlContributionShare: number;
    position: { symbol: string };
  }) => (
    <div
      data-contribution-share={pnlContributionShare}
      data-testid="open-position"
    >
      {position.symbol}
    </div>
  ),
}));

function renderedSymbols() {
  return screen
    .getAllByTestId("open-position")
    .map((item) => item.textContent);
}

describe("OpenPositions PnL sorting", () => {
  it("shows every configured BOTH coin even when neither leg is open", () => {
    render(
      <OpenPositions
        availableTags={[]}
        coinDescriptions={{}}
        coinTags={{}}
        config={{ openDirection: "BOTH", symbols: ["SUI", "AAVE"] } as any}
        entryDiagnostics={[
          {
            code: "STREAK_REENTRY_WAITING",
            level: 2,
            pointId: "TOP[2]-C",
            reason: "Waiting for the next confirmed TOP before reopening COUNTER LONG",
            role: "COUNTER",
            status: "blocked",
            symbol: "SUI",
          },
        ]}
        entryDiagnosticsGeneratedAt={Date.UTC(2026, 7, 30, 6, 43, 12)}
        entryDiagnosticsLoading={false}
        captureEntryLastRunAt={Date.UTC(2026, 7, 30, 6, 40, 9)}
        exchangeType={"binance" as any}
        mode="sandbox"
        onCoinDescriptionChange={vi.fn()}
        onCoinTagsChange={vi.fn()}
        positions={[]}
        spendableQuoteAsset={0}
        tagColors={{}}
        tagDescriptions={{}}
        volatilityMap={{}}
        volume24hBySymbol={{}}
      />,
    );

    // PROD:OPEN_POSITION_BOTH_LEG
    expect(screen.getByRole("button", { name: "Expand SUI position" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Expand AAVE position" })).toBeTruthy();
    expect(document.body.textContent).toContain(
      "Waiting for the next confirmed TOP before reopening COUNTER LONG",
    );
    expect(screen.queryByText(/See Entry Decisions/)).toBeNull();
  });

  it("treats a legacy retained closed leg as a missing diagnostic slot", () => {
    const closedCounter = createTestPosition({
      direction: "SHORT",
      role: "COUNTER",
      symbol: "APT",
    });
    closedCounter.closed = {
      feeUsdt: 0,
      message: "target exit",
      price: 10,
      reason: "VOLATILITY_TARGET_EXIT",
      t: 2,
    };

    render(
      <OpenPositions
        availableTags={[]}
        coinDescriptions={{}}
        coinTags={{}}
        config={{ openDirection: "BOTH", symbols: ["APT"] } as any}
        entryDiagnostics={[
          {
            code: "STREAK_REENTRY_WAITING",
            reason: "COUNTER is waiting for an unused confirmed vPoint",
            role: "COUNTER",
            status: "ready",
            symbol: "APT",
          },
        ]}
        entryDiagnosticsGeneratedAt={Date.UTC(2026, 7, 30, 6, 43, 12)}
        captureEntryLastRunAt={Date.UTC(2026, 7, 30, 6, 40, 9)}
        exchangeType={"binance" as any}
        mode="sandbox"
        onCoinDescriptionChange={vi.fn()}
        onCoinTagsChange={vi.fn()}
        positions={[{ ...closedCounter, mode: "sandbox" as const }]}
        spendableQuoteAsset={0}
        tagColors={{}}
        tagDescriptions={{}}
        volatilityMap={{}}
        volume24hBySymbol={{}}
      />,
    );

    expect(screen.queryByTestId("open-position")).toBeNull();
    expect(document.body.textContent).toContain(
      "COUNTER is waiting for an unused confirmed vPoint",
    );
    expect(document.body.textContent).toContain(
      "Ready after the last Capture Entry pass",
    );
    expect(document.body.textContent).toContain("Decision checked 30 Aug 13:43:12");
    expect(document.body.textContent).toContain(
      "Capture Entry completed 30 Aug 13:40:09",
    );
  });

  it("closes both legs from the pair net-PnL card", () => {
    const onExitBoth = vi.fn().mockResolvedValue(undefined);

    render(
      <OpenPositions
        availableTags={[]}
        coinDescriptions={{}}
        coinTags={{}}
        config={{ openDirection: "BOTH" } as any}
        exchangeType={"okx" as any}
        mode="sandbox"
        onCoinDescriptionChange={vi.fn()}
        onCoinTagsChange={vi.fn()}
        onExitBoth={onExitBoth}
        positions={[
          {
            ...createTestPosition({ role: "MAIN", symbol: "SUI" }),
            mode: "sandbox" as const,
          },
          {
            ...createTestPosition({ role: "COUNTER", symbol: "SUI" }),
            mode: "sandbox" as const,
          },
        ]}
        spendableQuoteAsset={0}
        tagColors={{}}
        tagDescriptions={{}}
        volatilityMap={{}}
        volume24hBySymbol={{}}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Expand SUI position" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close Both" }));

    // PROD:MANUAL_EXIT_POSITION_ROLE
    expect(onExitBoth).toHaveBeenCalledWith("SUI");
  });

  it("starts worst-first and toggles to best-first", () => {
    render(
      <OpenPositions
        availableTags={[]}
        coinDescriptions={{}}
        coinTags={{}}
        config={{} as any}
        exchangeType={"okx" as any}
        mode="sandbox"
        onCoinDescriptionChange={vi.fn()}
        onCoinTagsChange={vi.fn()}
        positions={
          [
            { ...createTestPosition({
              netPct: -1,
              netUsdt: -2,
              symbol: "MID",
            }), mode: "sandbox" as const },
            { ...createTestPosition({
              netPct: 2,
              netUsdt: 3,
              symbol: "BEST",
            }), mode: "sandbox" as const },
            { ...createTestPosition({
              netPct: -4.2,
              netUsdt: -5,
              symbol: "WORST",
            }), mode: "sandbox" as const },
          ]
        }
        spendableQuoteAsset={0}
        tagColors={{}}
        tagDescriptions={{}}
        volatilityMap={{}}
        volume24hBySymbol={{}}
      />,
    );

    expect(renderedSymbols()).toEqual(["WORST", "MID", "BEST"]);
    expect(
      screen
        .getAllByTestId("open-position")
        .map((item) => Number(item.dataset.contributionShare)),
    ).toEqual([0.5, 0.2, 0.3]);

    fireEvent.click(screen.getByLabelText("Sort PnL best first"));

    expect(renderedSymbols()).toEqual(["BEST", "MID", "WORST"]);
    expect(screen.getByLabelText("Sort PnL worst first")).toBeTruthy();
  });

  it("calculates restrained contribution intensity", () => {
    expect(
      openPositionPnlContribution.totalAbsolute([
        { pnl: { netUsdt: -2 } },
        { pnl: { netUsdt: 3 } },
        { pnl: { netUsdt: Number.NaN } },
      ]),
    ).toBe(5);
    expect(openPositionPnlContribution.share(-2, 5)).toBe(0.4);
    expect(openPositionPnlContribution.share(2, 0)).toBe(0);
    expect(openPositionPnlContribution.opacity(0)).toBe(0);
    expect(openPositionPnlContribution.opacity(0.01)).toBeLessThan(
      openPositionPnlContribution.opacity(0.5),
    );
    expect(openPositionPnlContribution.opacity(1)).toBe(0.18);
  });
});
