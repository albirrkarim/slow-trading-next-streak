import slowTradingSignals from "@/lib/slowTrading/signals";
import { describe, expect, it } from "vitest";

function createStorage(entryLegs: "MAIN" | "COUNTER" | "BOTH") {
  return {
    account: {
      name: "Primary account",
      slug: "binance-1",
    },
    config: {
      entryLegs,
      openDirection: "BOTH",
      symbols: ["AAVE"],
    },
    modes: {
      sandbox: {
        tradeSettings: [
          {
            model_memory: { positions: [] },
            symbol: "AAVE",
          },
        ],
      },
    },
    runtime: {
      sandboxEnabled: true,
    },
  } as any;
}

describe("multi-account entry diagnostics", () => {
  it("gives every role an account-attributed outcome", () => {
    const diagnostics = slowTradingSignals.diagnostics.attachAccount({
      diagnostics: [
        {
          code: "ENTRY_OUTSIDE_ABS_LEVEL_RANGE",
          level: 0,
          reason: "Outside the configured range 2-5.",
          status: "blocked",
          symbol: "AAVE",
        },
      ],
      storage: createStorage("MAIN"),
    });

    // PROD:MULTI_ACCOUNT_ENTRY_DIAGNOSTICS
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "ENTRY_OUTSIDE_ABS_LEVEL_RANGE",
        role: "MAIN",
        source: {
          accountName: "Primary account",
          accountSlug: "binance-1",
          scope: "account",
        },
      }),
      expect.objectContaining({
        code: "ACCOUNT_ENTRY_LEG_DISABLED",
        reason:
          "Blocked because Primary account is configured to open MAIN only, not COUNTER.",
        role: "COUNTER",
        source: {
          accountName: "Primary account",
          accountSlug: "binance-1",
          scope: "account",
        },
      }),
    ]);
  });
});
