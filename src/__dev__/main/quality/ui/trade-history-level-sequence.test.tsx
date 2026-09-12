/**
 * @vitest-environment jsdom
 */

import {
  fireEvent,
  render,
  screen,
  waitForElementToBeRemoved,
  within,
} from "@testing-library/react";
import { SnackbarProvider } from "notistack";
import { describe, expect, it, vi } from "vitest";

import { TradesTableSection } from "@/components/LiveDashboard/Reporting/TradesTableSection";
import { createTestPosition } from "../fixtures/position";

vi.mock(
  "@/components/LiveDashboard/Shared/NetProfitPercentHistorySparkline",
  () => ({
    NetProfitPercentHistorySparkline: () => (
      <div data-testid="pnl-history-chart" />
    ),
  }),
);

describe("trade-history level sequence", () => {
  it("shows the persisted entry, averaging, monitoring, and exit path below the PnL chart", async () => {
    const position = createTestPosition({
      averaging: {
        entryLevel: -2,
        executions: [
          {
            allocationPct: 2,
            level: -4,
            marginUsdt: 40,
            monitoringState: {
              lastUpdated: 250,
              reason: "No Speedup rule matched",
              stage: "standard",
            },
            price: 8,
            vPointPrice: 8,
            t: 250,
          },
          {
            allocationPct: 5,
            level: -3,
            marginUsdt: 20,
            monitoringState: {
              lastUpdated: 200,
              reason: "Negative PnL threshold matched",
              stage: "speedup",
            },
            price: 9,
            vPointPrice: 9,
            t: 200,
          },
        ],
        lastHandledLevel: -3,
        reserveBaseMarginUsdt: 10,
        reservedRemainingMarginUsdt: 0,
        steps: [
          {
            allocationPct: 5,
            level: -3,
            marginUsdt: 20,
            status: "USED",
          },
        ],
      },
      closed: {
        feeUsdt: 0,
        message: "[EXIT] Target reached",
        price: 11,
        reason: "TAKE_PROFIT",
        t: 300,
        vPoint: { id: "T_EXIT", lvl: 0 },
      },
      entryLevel: -2,
      entryTime: 100,
      pnl: {
        history: [
          { pct: 0, t: 100 },
          { pct: 10, t: 300 },
        ],
        netPct: 10,
        netUsdt: 1,
        maxUpUsdt: 4.25,
        maxDownUsdt: -3.5,
      },
      symbol: "SUI",
    });
    position.lastMonitoringStage = {
      lastUpdated: 290,
      reason: "Positive PnL threshold matched before exit",
      stage: "speedup",
    };

    render(
      <SnackbarProvider>
        <TradesTableSection
          exchangeType="binance"
          history={[{ ...position, mode: "sandbox" }]}
          mode="sandbox"
          onHistoryChange={vi.fn()}
          readOnly
          reserveMultiplier={2}
        />
      </SnackbarProvider>,
    );

    // BOTH:REUSABLE_LEVEL_SEQUENCE
    const pnlCell = screen.getByLabelText(
      "PnL history and level sequence for SUI",
    );
    const chart = within(pnlCell).getByTestId("pnl-history-chart");
    const sequence = within(pnlCell).getByLabelText("Position level sequence");

    expect(
      within(sequence)
        .getAllByText(/^L/)
        .map((chip) => chip.textContent),
    ).toEqual(["L-2", "L-3 AVG 5x", "L-4 AVG 2x", "L0 EXIT"]);
    // PROD:AVERAGING_MONITORING_STATE_SNAPSHOT
    const averagingSpeedupIcon = within(sequence).getByLabelText(
      "Speedup monitoring state at averaging level -3",
    );
    expect(
      within(sequence).getByLabelText(
        "Standard monitoring state at averaging level -4",
      ),
    ).toBeTruthy();
    fireEvent.mouseOver(averagingSpeedupIcon);
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "Negative PnL threshold matched",
    );
    fireEvent.mouseOut(averagingSpeedupIcon);
    await waitForElementToBeRemoved(() => screen.queryByRole("tooltip"));

    // PROD:TRADE_HISTORY_EXIT_MONITORING_STAGE
    const exitSpeedupIcon = within(sequence).getByLabelText(
      "Speedup monitoring stage at exit level 0",
    );
    expect(exitSpeedupIcon.getAttribute("tabindex")).toBe("0");
    fireEvent.mouseOver(exitSpeedupIcon);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Positive PnL threshold matched before exit",
    );
    expect(chart.nextElementSibling?.contains(sequence)).toBe(true);
    expect(screen.getByText("Max Up USD")).toBeTruthy();
    expect(screen.getByText("Max Down USD")).toBeTruthy();
    expect(screen.getByText("$+4.25")).toBeTruthy();
    expect(screen.getByText("$-3.50")).toBeTruthy();
    expect(screen.queryByText("sandbox")).toBeNull();
  });

  it("shows persisted levels that were reached without averaging", () => {
    const position = createTestPosition({
      averaging: {
        entryLevel: -2,
        executions: [
          {
            allocationPct: 2,
            level: -4,
            marginUsdt: 40,
            price: 8,
            vPointPrice: 8,
            t: 250,
          },
        ],
        lastHandledLevel: -4,
        reserveBaseMarginUsdt: 10,
        reservedRemainingMarginUsdt: 0,
        steps: [],
      },
      closed: {
        feeUsdt: 0,
        message: "[EXIT] Closed",
        price: 11,
        reason: "TAKE_PROFIT",
        t: 300,
        vPoint: { id: "T_EXIT", lvl: 0 },
      },
      entryId: "B_ENTRY",
      entryLevel: -2,
      symbol: "SUI",
      vPoints: [
        { id: "B_NOT_AVERAGED", lvl: -3 },
        { id: "B_AVERAGED", lvl: -4 },
      ],
    });

    render(
      <SnackbarProvider>
        <TradesTableSection
          exchangeType="binance"
          history={[{ ...position, mode: "sandbox" }]}
          mode="sandbox"
          onHistoryChange={vi.fn()}
          readOnly
          reserveMultiplier={2}
        />
      </SnackbarProvider>,
    );

    // BOTH:POSITION_VPOINT_PATH
    const sequence = screen.getByLabelText("Position level sequence");
    expect(
      within(sequence)
        .getAllByText(/^L/)
        .map((chip) => chip.textContent),
    ).toEqual(["L-2", "L-3 NOT AVG", "L-4 AVG 2x", "L0 EXIT"]);
  });

  it("keeps distinct signed levels when a LONG history crosses zero", () => {
    const position = createTestPosition({
      averaging: {
        entryLevel: 1,
        lastHandledLevel: 1,
        reserveBaseMarginUsdt: 10,
        reservedRemainingMarginUsdt: 0,
        steps: [],
      },
      closed: {
        feeUsdt: 0,
        message: "[EXIT] Closed",
        price: 9,
        reason: "STOP_LOSS",
        t: 400,
        vPoint: { id: "B_EXIT", lvl: -2 },
      },
      direction: "LONG",
      entryId: "T_ENTRY",
      entryLevel: 1,
      symbol: "LINK",
      vPoints: [
        { id: "B_ZERO", lvl: 0 },
        { id: "B_NEGATIVE_ONE", lvl: -1 },
      ],
    });

    render(
      <SnackbarProvider>
        <TradesTableSection
          exchangeType="binance"
          history={[{ ...position, mode: "sandbox" }]}
          mode="sandbox"
          onHistoryChange={vi.fn()}
          readOnly
          reserveMultiplier={2}
        />
      </SnackbarProvider>,
    );

    const sequence = screen.getByLabelText("Position level sequence");
    expect(
      within(sequence)
        .getAllByText(/^L/)
        .map((chip) => chip.textContent),
    ).toEqual(["L1", "L0 NOT AVG", "L-1 NOT AVG", "L-2 EXIT"]);
  });

  it("combines averaging and exit when both happened at the same level", () => {
    const position = createTestPosition({
      averaging: {
        entryLevel: 0,
        executions: [
          {
            allocationPct: 3,
            level: 1,
            marginUsdt: 15,
            price: 0.87,
            vPointPrice: 0.87,
            t: 200,
          },
        ],
        lastHandledLevel: 1,
        reserveBaseMarginUsdt: 5,
        reservedRemainingMarginUsdt: 0,
        steps: [],
      },
      closed: {
        feeUsdt: 0,
        message: "[EXIT] Post-average rescue",
        price: 0.87,
        reason: "POST_AVERAGE_RESCUE_EXIT",
        t: 300,
        vPoint: { id: "T_EXIT", lvl: 1 },
      },
      entryId: "B_ENTRY",
      entryLevel: 0,
      symbol: "ZRO",
      vPoints: [{ id: "T_AVERAGED", lvl: 1 }],
    });

    render(
      <SnackbarProvider>
        <TradesTableSection
          exchangeType="binance"
          history={[{ ...position, mode: "sandbox" }]}
          mode="sandbox"
          onHistoryChange={vi.fn()}
          readOnly
          reserveMultiplier={3}
        />
      </SnackbarProvider>,
    );

    const sequence = screen.getByLabelText("Position level sequence");
    expect(
      within(sequence)
        .getAllByText(/^L/)
        .map((chip) => chip.textContent),
    ).toEqual(["L0", "L1 AVG 3x EXIT"]);
  });
});
