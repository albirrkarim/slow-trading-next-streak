import {
  TradingMode,
  UnifiedOrderSide,
  UnifiedOrderType,
} from "@/lib/exchange";
import { BinanceAdapter } from "@/lib/exchange/adapters/binance";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  changePositionMode: vi.fn(),
  createFuturesOrder: vi.fn(),
  getFuturesSymbolInfo: vi.fn(),
  getPositionMode: vi.fn(),
}));

vi.mock("@/lib/exchange/platform/binance", () => ({
  binance: {
    futures: {
      createFuturesOrder: mocks.createFuturesOrder,
      positionMode: {
        change: mocks.changePositionMode,
        get: mocks.getPositionMode,
      },
    },
  },
}));

vi.mock("@/lib/exchange/platform/binance/futures/exchangeInfo", () => ({
  getFuturesSymbolInfo: mocks.getFuturesSymbolInfo,
}));

function createExchange() {
  return new BinanceAdapter({
    defaultTradingMode: TradingMode.FUTURES,
    futuresPositionMode: "HEDGE",
  });
}

describe("Binance futures Hedge Mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getFuturesSymbolInfo.mockResolvedValue({
      minQty: 1,
      stepSize: 1,
      tickSize: 0.000001,
    });
    mocks.getPositionMode.mockResolvedValue("HEDGE");
    mocks.changePositionMode.mockImplementation(async (mode) => mode);
    mocks.createFuturesOrder.mockImplementation(async (params) => ({
      orderId: 1,
      clientOrderId: "hedge-order",
      status: "FILLED",
      executedQty: params.quantity,
      avgPrice: "1",
      updateTime: 1,
      origQty: params.quantity,
      positionSide: params.positionSide,
    }));
  });

  it.each([
    ["LONG entry", "ENTRY", UnifiedOrderSide.BUY, "LONG"],
    ["SHORT entry", "ENTRY", UnifiedOrderSide.SELL, "SHORT"],
    ["LONG exit", "EXIT", UnifiedOrderSide.SELL, "LONG"],
    ["SHORT exit", "EXIT", UnifiedOrderSide.BUY, "SHORT"],
  ] as const)(
    "maps %s to the correct Binance positionSide",
    async (_label, tradeType, side, expectedPositionSide) => {
      const result = await createExchange().createOrder({
        tradeType,
        symbol: "W_USDT",
        side,
        type: UnifiedOrderType.MARKET,
        quantity: 10,
        tradingMode: TradingMode.FUTURES,
        reduceOnly: tradeType === "EXIT",
      });

      expect(mocks.createFuturesOrder).toHaveBeenCalledWith(
        // PROD:HEDGE_ORDER_POSITION_SIDE
        expect.objectContaining({
          positionSide: expectedPositionSide,
          quantity: "10",
          symbol: "WUSDT",
        }),
      );
      expect(mocks.createFuturesOrder.mock.calls[0]?.[0]).not.toHaveProperty(
        "reduceOnly",
      );
      expect(result.positionSide).toBe(expectedPositionSide);
    },
  );

  it("honors an explicit Hedge Mode position side", async () => {
    await createExchange().createOrder({
      tradeType: "ENTRY",
      symbol: "W_USDT",
      side: UnifiedOrderSide.BUY,
      type: UnifiedOrderType.MARKET,
      quantity: 10,
      tradingMode: TradingMode.FUTURES,
      positionSide: "short",
    });

    expect(mocks.createFuturesOrder).toHaveBeenCalledWith(
      expect.objectContaining({ positionSide: "SHORT" }),
    );
  });

  it("lazily reads and caches the account mode when it is not configured", async () => {
    const exchange = new BinanceAdapter({
      defaultTradingMode: TradingMode.FUTURES,
    });

    for (const side of [UnifiedOrderSide.BUY, UnifiedOrderSide.SELL]) {
      await exchange.createOrder({
        tradeType: "ENTRY",
        symbol: "W_USDT",
        side,
        type: UnifiedOrderType.MARKET,
        quantity: 10,
        tradingMode: TradingMode.FUTURES,
      });
    }

    expect(mocks.getPositionMode).toHaveBeenCalledOnce();
    expect(mocks.createFuturesOrder).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ positionSide: "LONG" }),
    );
    expect(mocks.createFuturesOrder).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ positionSide: "SHORT" }),
    );
  });

  it("updates the configured mode after changing the account mode", async () => {
    const exchange = new BinanceAdapter({
      defaultTradingMode: TradingMode.FUTURES,
      futuresPositionMode: "ONE_WAY",
    });

    await expect(exchange.setFuturesPositionMode("HEDGE")).resolves.toBe(
      "HEDGE",
    );
    await expect(exchange.getFuturesPositionMode()).resolves.toBe("HEDGE");
  });

  it("requires a direction when closePosition sees both Hedge Mode legs", async () => {
    const exchange = createExchange();
    exchange.getPositions = vi.fn().mockResolvedValue([
      {
        symbol: "W_USDT",
        originalSymbol: "WUSDT",
        side: "LONG",
        amount: 10,
        entryPrice: 1,
      },
      {
        symbol: "W_USDT",
        originalSymbol: "WUSDT",
        side: "SHORT",
        amount: 10,
        entryPrice: 1,
      },
    ]);

    await expect(
      exchange.closePosition("W_USDT", {
        tradingMode: TradingMode.FUTURES,
      }),
    ).rejects.toThrow("Direction is required");
  });

  it("closes only the requested Hedge Mode leg", async () => {
    const exchange = createExchange();
    exchange.getPositions = vi.fn().mockResolvedValue([
      {
        symbol: "W_USDT",
        originalSymbol: "WUSDT",
        side: "LONG",
        amount: 8,
        entryPrice: 1,
      },
      {
        symbol: "W_USDT",
        originalSymbol: "WUSDT",
        side: "SHORT",
        amount: 12,
        entryPrice: 1,
      },
    ]);

    await exchange.closePosition("W_USDT", {
      direction: "SHORT",
      tradingMode: TradingMode.FUTURES,
    });

    expect(mocks.createFuturesOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        positionSide: "SHORT",
        quantity: "12",
        side: "BUY",
      }),
    );
  });
});
