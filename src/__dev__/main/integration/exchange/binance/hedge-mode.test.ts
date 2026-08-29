import fs from "fs-extra";
import path from "node:path";
import {
  getExchange,
  TradingMode,
  UnifiedOrderSide,
  UnifiedOrderType,
  type IExchange,
} from "@/lib/exchange";
import {
  runWithExchangeAccount,
  type ExchangeAccount,
} from "@/lib/exchange/account-context";
import { describe, expect, test } from "vitest";

const LIVE_TEST_ENABLED = process.env.RUN_LIVE_BINANCE_HEDGE_TEST === "1";
const ACCOUNT_NAME = "Main Account 1";
const LEVERAGE = 2;
const TARGET_MARGIN_USDT = 5;
const HOLD_OPEN_MS = Math.max(
  0,
  Number(process.env.LIVE_BINANCE_HEDGE_HOLD_MS) || 0,
);
const CANDIDATE_SYMBOLS = [
  "XRP_USDT",
  "ADA_USDT",
  "DOGE_USDT",
  "TRX_USDT",
] as const;

interface AccountsFile {
  accounts: ExchangeAccount[];
}

/** Loads the explicitly selected local exchange account without logging secrets. */
async function loadExchangeAccount(): Promise<ExchangeAccount> {
  const accountsFile = path.resolve(
    process.env.LIVE_BINANCE_ACCOUNTS_FILE ??
      "storage/persistent/instances/3010/slow/accounts.json",
  );
  const data = await fs.readJSON(accountsFile) as AccountsFile;
  const account = data.accounts.find(
    (candidate) =>
      candidate.name === ACCOUNT_NAME && candidate.type === "binance",
  );
  if (!account) {
    throw new Error(`Binance account ${ACCOUNT_NAME} was not found`);
  }
  return account;
}

/** Chooses a liquid symbol with no existing leg and about $5 margin per leg. */
async function selectSmokeSymbol(exchange: IExchange) {
  const openSymbols = new Set(
    (await exchange.getPositions()).map((position) => position.symbol),
  );
  const tickers = await exchange.getTickers({
    containSymbol: "USDT",
    marketType: "FUTURES",
  });

  for (const symbol of CANDIDATE_SYMBOLS) {
    if (openSymbols.has(symbol)) continue;
    const exchangeSymbol = exchange.denormalizeSymbol(symbol);
    const ticker = tickers.find(
      (candidate) => candidate.symbol === exchangeSymbol,
    );
    const price = Number(ticker?.lastPrice);
    if (!Number.isFinite(price) || price <= 0) continue;

    const quantity = await exchange.adjustQuantity(
      TARGET_MARGIN_USDT * LEVERAGE / price,
      symbol,
    );
    const marginUsdt = quantity * price / LEVERAGE;
    if (
      quantity > 0 &&
      marginUsdt >= TARGET_MARGIN_USDT * 0.8 &&
      marginUsdt <= TARGET_MARGIN_USDT * 1.2
    ) {
      return { marginUsdt, price, quantity, symbol };
    }
  }

  throw new Error("No clean Binance futures symbol fit the live smoke budget");
}

/** Closes every test leg for one symbol, even after a partial entry failure. */
async function cleanupSmokePositions(exchange: IExchange, symbol: string) {
  const errors: string[] = [];
  for (const direction of ["LONG", "SHORT"] as const) {
    try {
      const position = (await exchange.getPositions(symbol)).find(
        (candidate) => candidate.side === direction,
      );
      if (!position) continue;

      await exchange.closePosition(symbol, {
        direction,
        tradingMode: TradingMode.FUTURES,
      });
      const confirmation = await exchange.ensureClosed({ direction, symbol });
      if (!confirmation.closed) {
        errors.push(
          `${direction} retained ${confirmation.remainingAmount} after cleanup`,
        );
      }
    } catch (error) {
      errors.push(
        `${direction}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(`Binance Hedge Mode cleanup failed: ${errors.join("; ")}`);
  }
}

describe.skipIf(!LIVE_TEST_ENABLED)("Binance Hedge Mode live smoke", () => {
  test("opens simultaneous $5-margin LONG and SHORT legs at 2x, then closes both", async () => {
    const account = await loadExchangeAccount();

    await runWithExchangeAccount(account, async () => {
      const exchange = getExchange("binance", {
        defaultTradingMode: TradingMode.FUTURES,
      });
      expect(await exchange.getFuturesPositionMode?.()).toBe("HEDGE");

      const smoke = await selectSmokeSymbol(exchange);
      const balance = await exchange.getBalance("USDT");
      const requiredAvailable = smoke.marginUsdt * 2 + 2;
      if ((balance?.available ?? balance?.quoteAsset ?? 0) < requiredAvailable) {
        throw new Error(
          `Need at least ${requiredAvailable.toFixed(2)} available USDT for the bounded smoke test`,
        );
      }

      expect(await exchange.setLeverage(smoke.symbol, LEVERAGE)).toBe(true);
      console.log(
        `Live Hedge smoke: ${smoke.symbol}, ${smoke.quantity} quantity, ` +
          `~${smoke.marginUsdt.toFixed(2)} USDT margin per leg at ${LEVERAGE}x`,
      );

      try {
        await exchange.createOrder({
          tradeType: "ENTRY",
          symbol: smoke.symbol,
          side: UnifiedOrderSide.BUY,
          type: UnifiedOrderType.MARKET,
          quantity: smoke.quantity,
          tradingMode: TradingMode.FUTURES,
          positionSide: "long",
        });
        await exchange.createOrder({
          tradeType: "ENTRY",
          symbol: smoke.symbol,
          side: UnifiedOrderSide.SELL,
          type: UnifiedOrderType.MARKET,
          quantity: smoke.quantity,
          tradingMode: TradingMode.FUTURES,
          positionSide: "short",
        });

        const positions = await exchange.getPositions(smoke.symbol);
        expect(positions.some((position) => position.side === "LONG")).toBe(true);
        expect(positions.some((position) => position.side === "SHORT")).toBe(true);
        if (HOLD_OPEN_MS > 0) {
          console.log(
            `Both Hedge Mode legs are visible; holding them open for ${Math.round(HOLD_OPEN_MS / 1_000)} seconds`,
          );
          await new Promise((resolve) => setTimeout(resolve, HOLD_OPEN_MS));
        }
      } finally {
        await cleanupSmokePositions(exchange, smoke.symbol);
      }

      const remaining = await exchange.getPositions(smoke.symbol);
      expect(remaining).toHaveLength(0);
    });
  }, 120_000);
});
