/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import moment from "moment-timezone";
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
  return screen.getAllByTestId("open-position").map((item) => item.textContent);
}

describe("OpenPositions PnL sorting", () => {
  it("collapses ready details into the Ready chip tooltip", async () => {
    const sharedReason = "Shared entry guards passed.";

    render(
      <OpenPositions
        availableTags={[]}
        coinDescriptions={{}}
        coinTags={{}}
        config={{ openDirection: "BOTH", symbols: ["AAVE"] } as any}
        entryDiagnostics={[
          {
            code: "SHARED_ENTRY_GUARDS_READY",
            reason: sharedReason,
            source: { scope: "shared" },
            status: "ready",
            symbol: "AAVE",
          },
          {
            code: "ENTRY_OUTSIDE_ABS_LEVEL_RANGE",
            level: 0,
            reason: "Outside Main's configured range 0-2.",
            role: "MAIN",
            source: {
              accountName: "Main",
              accountSlug: "binance-1",
              scope: "account",
            },
            status: "blocked",
            symbol: "AAVE",
          },
          {
            code: "ENTRY_OUTSIDE_ABS_LEVEL_RANGE",
            level: 0,
            reason: "Outside Second's configured range 2-5.",
            role: "MAIN",
            source: {
              accountName: "Second",
              accountSlug: "binance-2",
              scope: "account",
            },
            status: "blocked",
            symbol: "AAVE",
          },
        ]}
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

    expect(screen.getAllByText("Shared guard")).toHaveLength(2);
    expect(screen.queryByText(sharedReason)).toBeNull();
    expect(screen.queryByText("SHARED_ENTRY_GUARDS_READY")).toBeNull();
    expect(
      screen.getByText("Outside Main's configured range 0-2."),
    ).toBeTruthy();
    expect(
      screen.getByText("Outside Second's configured range 2-5."),
    ).toBeTruthy();

    const mainCard = screen
      .getByRole("button", { name: "Collapse Main details" })
      .parentElement?.parentElement?.parentElement;
    expect(mainCard).not.toBeNull();
    const readyChip = within(mainCard!).getByText("Ready");

    // PROD:MULTI_ACCOUNT_ENTRY_DIAGNOSTICS
    fireEvent.mouseOver(readyChip);
    const tooltip = await screen.findByRole("tooltip");
    expect(within(tooltip).getByText(sharedReason)).toBeTruthy();
    expect(
      within(tooltip).getByText("SHARED_ENTRY_GUARDS_READY"),
    ).toBeTruthy();
  });

  it("collapses a disabled account leg into a tooltip chip", async () => {
    const reason =
      "Blocked because Second is configured to open MAIN only, not COUNTER.";

    render(
      <OpenPositions
        availableTags={[]}
        coinDescriptions={{}}
        coinTags={{}}
        config={{ openDirection: "BOTH", symbols: ["AAVE"] } as any}
        entryDiagnostics={[
          {
            code: "SHARED_ENTRY_GUARDS_READY",
            reason: "Shared entry guards passed.",
            source: { scope: "shared" },
            status: "ready",
            symbol: "AAVE",
          },
          {
            code: "ACCOUNT_ENTRY_LEG_DISABLED",
            reason,
            role: "COUNTER",
            source: {
              accountName: "Second",
              accountSlug: "binance-2",
              scope: "account",
            },
            status: "blocked",
            symbol: "AAVE",
          },
        ]}
        entryDiagnosticsGeneratedAt={Date.UTC(2026, 8, 15, 6, 34, 24)}
        captureEntryLastRunAt={Date.UTC(2026, 8, 15, 6, 30, 49)}
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

    const counterCard = screen
      .getByRole("button", { name: "Collapse Counter details" })
      .parentElement?.parentElement?.parentElement;
    expect(counterCard).not.toBeNull();
    const counter = within(counterCard!);
    const disabledChip = counter.getByText("Disabled");

    // PROD:MULTI_ACCOUNT_ENTRY_DIAGNOSTICS
    expect(counter.getByText("Second")).toBeTruthy();
    expect(counter.queryByText(reason)).toBeNull();
    expect(
      counter.queryByText(/Ready after the last Capture Entry pass/),
    ).toBeNull();
    expect(counter.queryByText(/Decision checked/)).toBeNull();
    expect(counter.queryByText(/Capture Entry completed/)).toBeNull();
    fireEvent.mouseOver(disabledChip);
    expect((await screen.findByRole("tooltip")).textContent).toBe(reason);
  });

  it("shows the next Capture Entry timing when an account is ready", () => {
    const currentTimeMs = Date.now();
    const captureEntryLastRunAt = currentTimeMs - 4 * 60 * 1000;
    const nextRunAt = captureEntryLastRunAt + 5 * 60 * 1000;

    render(
      <OpenPositions
        availableTags={[]}
        captureEntryIntervalMinutes={5}
        captureEntryLastRunAt={captureEntryLastRunAt}
        coinDescriptions={{}}
        coinTags={{}}
        config={{ openDirection: "BOTH", symbols: ["AAVE"] } as any}
        entryDiagnostics={[
          {
            code: "SHARED_ENTRY_GUARDS_READY",
            reason: "Shared entry guards passed.",
            source: { scope: "shared" },
            status: "ready",
            symbol: "AAVE",
          },
          {
            code: "READY",
            reason: "Main is ready.",
            role: "COUNTER",
            source: {
              accountName: "Main",
              accountSlug: "binance-1",
              scope: "account",
            },
            status: "ready",
            symbol: "AAVE",
          },
          {
            code: "ACCOUNT_ENTRY_LEG_DISABLED",
            reason: "Second opens MAIN only.",
            role: "COUNTER",
            source: {
              accountName: "Second",
              accountSlug: "binance-2",
              scope: "account",
            },
            status: "blocked",
            symbol: "AAVE",
          },
        ]}
        entryDiagnosticsGeneratedAt={currentTimeMs - 30_000}
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

    const counterCard = screen
      .getByRole("button", { name: "Collapse Counter details" })
      .parentElement?.parentElement?.parentElement;
    expect(counterCard).not.toBeNull();
    const counter = within(counterCard!);

    // PROD:MULTI_ACCOUNT_ENTRY_DIAGNOSTICS
    expect(counter.getByText("1/2 ready")).toBeTruthy();
    expect(
      counter.getByText(/Ready after the last Capture Entry pass/),
    ).toBeTruthy();
    expect(counter.getByText(/Decision checked/)).toBeTruthy();
    expect(counter.getByText(/Capture Entry completed/)).toBeTruthy();
    expect(
      counter.getByText(
        `Next Capture Entry cycle in 1 minute at ${moment(nextRunAt)
          .tz("Asia/Jakarta")
          .format("HH:mm")} WIB.`,
      ),
    ).toBeTruthy();
  });

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

  it("treats a legacy retained closed leg as a missing diagnostic slot", async () => {
    const reason = "COUNTER is waiting for an unused confirmed vPoint";
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
            reason,
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
    expect(screen.queryByText(reason)).toBeNull();
    expect(document.body.textContent).toContain(
      "Ready after the last Capture Entry pass",
    );
    expect(document.body.textContent).toContain("Decision checked 30 Aug 13:43:12");
    expect(document.body.textContent).toContain(
      "Capture Entry completed 30 Aug 13:40:09",
    );

    const readyRow = screen.getByText("Shared guard").parentElement;
    expect(readyRow).not.toBeNull();
    fireEvent.mouseOver(within(readyRow!).getByText("Ready"));
    const tooltip = await screen.findByRole("tooltip");
    expect(within(tooltip).getByText(reason)).toBeTruthy();
    expect(within(tooltip).getByText("STREAK_REENTRY_WAITING")).toBeTruthy();
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
    expect(onExitBoth).toHaveBeenCalledWith(
      expect.objectContaining({
        account: "binance-1",
        symbol: "SUI",
        role: "MAIN",
      }),
    );
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
        positions={[
          {
            ...createTestPosition({
              netPct: -1,
              netUsdt: -2,
              symbol: "MID",
            }),
            mode: "sandbox" as const,
          },
          {
            ...createTestPosition({
              netPct: 2,
              netUsdt: 3,
              symbol: "BEST",
            }),
            mode: "sandbox" as const,
          },
          {
            ...createTestPosition({
              netPct: -4.2,
              netUsdt: -5,
              symbol: "WORST",
            }),
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
