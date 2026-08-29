import {
  DEFAULT_DYNAMIC_TRADE_CONFIG_PRODUCTION,
  DEFAULT_DYNAMIC_TRADING_MEMORY,
} from "@/lib/dynamic";
import type { TradingModelMemory } from "@/lib/trading/models";
import blackSwan from "@/lib/trading/black-swan";
import { clone, normalizeSymbol, uniqueSymbols } from "./common";
import { DEFAULT_SANDBOX_INITIAL_BALANCE } from "./constants";
import type {
  SlowTradingMode,
  SlowTradingHighVolatilityNotificationState,
  SlowTradingModeState,
  SlowTradingStorageData,
} from "../types";

/**
 * Build an empty model-memory object for a symbol with no trading history yet.
 *
 * @returns Empty trading model memory.
 */
function createEmptyModelMemory(): TradingModelMemory {
  return {
    positions: [],
  };
}

/**
 * Create the initial state container for one slow-trading mode.
 *
 * @param initialBalanceUSDT - Initial quote balance to seed the mode with.
 * @returns Fresh mode state with empty trade settings and memory.
 */
export function createModeState(initialBalanceUSDT = 0): SlowTradingModeState {
  return {
    tradeSettings: [],
    dynamicTradeMemory: {
      ...clone(DEFAULT_DYNAMIC_TRADING_MEMORY),
      quoteAsset: initialBalanceUSDT,
      startingBalanceUSDT: initialBalanceUSDT,
    },
    highVolatilityNotificationState: {
      email: {},
      telegram: {},
    },
    dailyPerformanceNotificationState: {},
    blackSwan: blackSwan.state.create(),
    stageRuns: {},
  };
}

/**
 * Resolve the currently active slow-trading mode from runtime settings.
 *
 * @param storage - Persisted slow-trading storage.
 * @returns Active mode string.
 */
export function getActiveSlowTradingMode(
  storage: SlowTradingStorageData,
): SlowTradingMode {
  return storage.runtime.sandboxEnabled ? "sandbox" : "live";
}

/**
 * Normalizes high volatility notification state into the shape expected by SLOW.
 */
function normalizeHighVolatilityNotificationState(
  value: unknown,
  symbols: string[],
): SlowTradingHighVolatilityNotificationState {
  if (!value || typeof value !== "object") {
    return { email: {}, telegram: {} };
  }

  const allowedSymbols = new Set([...uniqueSymbols(symbols), "BTC"]);
  const normalizeZones = (
    zones: unknown,
  ): Record<string, "POSITIVE" | "NEGATIVE"> => {
    const out: Record<string, "POSITIVE" | "NEGATIVE"> = {};
    if (!zones || typeof zones !== "object") {
      return out;
    }

    for (const [rawSymbol, rawZone] of Object.entries(zones)) {
      const symbol = normalizeSymbol(rawSymbol);
      if (!allowedSymbols.has(symbol)) {
        continue;
      }

      if (rawZone === "POSITIVE" || rawZone === "NEGATIVE") {
        out[symbol] = rawZone;
      }
    }

    return out;
  };
  const candidate = value as Record<string, unknown>;
  return {
    telegram: normalizeZones(candidate.telegram),
    email: normalizeZones(candidate.email),
  };
}

/** Keeps only valid UTC day markers for daily performance delivery state. */
function normalizeDailyPerformanceNotificationState(
  value: unknown,
): SlowTradingModeState["dailyPerformanceNotificationState"] {
  if (!value || typeof value !== "object") {
    return {};
  }

  const candidate = value as Record<string, unknown>;
  const normalized: SlowTradingModeState["dailyPerformanceNotificationState"] =
    {};

  for (const channel of ["telegram", "email"] as const) {
    const day = candidate[channel];
    if (
      typeof day === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(day) &&
      Number.isFinite(Date.parse(`${day}T00:00:00.000Z`))
    ) {
      normalized[channel] = day;
    }
  }

  return normalized;
}

/**
 * Rebuild the per-symbol trade-settings list while preserving existing model memory.
 *
 * Symbols removed from the scan config can still own open positions or freshly
 * closed positions waiting to be written to history. Those symbols stay managed
 * until their runtime memory is empty.
 *
 * @param state - Existing mode state.
 * @param symbols - Configured symbol list.
 * @returns Mode state aligned with the current symbols.
 */
export function ensureTradeSettings(
  state: SlowTradingModeState,
  symbols: string[],
): SlowTradingModeState {
  const configuredSymbols = uniqueSymbols(symbols);
  const existingBySymbol = new Map(
    state.tradeSettings.map((item) => [normalizeSymbol(item.symbol), item]),
  );
  const retainedPositionSymbols = state.tradeSettings
    .filter(
      (item) =>
        (item.model_memory.positions?.length ?? 0) > 0 ||
        (item.model_memory.positionsSell?.length ?? 0) > 0,
    )
    .map((item) => normalizeSymbol(item.symbol))
    .filter(Boolean);
  const nextSymbols = uniqueSymbols([
    ...configuredSymbols,
    ...retainedPositionSymbols,
  ]);
  const tradeSettings = nextSymbols.map((symbol) => {
    const existing = existingBySymbol.get(symbol);

    if (!existing?.model_memory) {
      return {
        symbol,
        model_memory: createEmptyModelMemory(),
      };
    }

    const modelMemory = {
      ...clone(existing.model_memory),
      positions: clone(existing.model_memory.positions ?? []),
    };

    if ((existing.model_memory.positionsSell?.length ?? 0) > 0) {
      modelMemory.positionsSell = clone(existing.model_memory.positionsSell);
    } else {
      delete modelMemory.positionsSell;
    }

    return {
      symbol,
      model_memory: modelMemory,
    };
  });

  return {
    ...state,
    tradeSettings,
    dynamicTradeMemory: {
      ...clone(DEFAULT_DYNAMIC_TRADING_MEMORY),
      ...clone(state.dynamicTradeMemory ?? DEFAULT_DYNAMIC_TRADING_MEMORY),
    },
    highVolatilityNotificationState: normalizeHighVolatilityNotificationState(
      state.highVolatilityNotificationState,
      nextSymbols,
    ),
    dailyPerformanceNotificationState:
      normalizeDailyPerformanceNotificationState(
        state.dailyPerformanceNotificationState,
      ),
    blackSwan: blackSwan.state.normalize(state.blackSwan),
  };
}

/**
 * Create the default mode states for slow trading.
 */
export function createDefaultModeStates(
  symbols = uniqueSymbols(DEFAULT_DYNAMIC_TRADE_CONFIG_PRODUCTION.symbols),
): SlowTradingStorageData["modes"] {
  const sandboxInitialBalanceUSDT = DEFAULT_SANDBOX_INITIAL_BALANCE;

  return {
    live: ensureTradeSettings(createModeState(0), symbols),
    sandbox: ensureTradeSettings(
      createModeState(sandboxInitialBalanceUSDT),
      symbols,
    ),
  };
}

/**
 * Update Safe Haven while preserving the active mode's total available quote.
 */
export function applySlowTradingSafeHavenUpdate(
  modeState: SlowTradingModeState,
  nextSafeHavenUSDT: number,
): {
  nextUSDT: number;
  previousUSDT: number;
} {
  const memory = modeState.dynamicTradeMemory;
  const previousUSDT = Number(memory.safeHaven) || 0;
  const nextUSDT = Math.max(0, nextSafeHavenUSDT);
  const delta = nextUSDT - previousUSDT;

  memory.safeHaven = nextUSDT;
  memory.quoteAsset = Math.max(0, (Number(memory.quoteAsset) || 0) - delta);

  return {
    nextUSDT,
    previousUSDT,
  };
}
