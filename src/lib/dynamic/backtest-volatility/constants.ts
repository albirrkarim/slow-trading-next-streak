import { getFeeCalculator } from "@/lib/exchange/fees";
import type { ExchangeType } from "@/lib/exchange";

export const BACKTEST_ONE_SIDE_FEE_RATIO = 0.001;
export const BACKTEST_ROUND_TRIP_FEE_PERCENT =
  BACKTEST_ONE_SIDE_FEE_RATIO * 2 * 100;

/** Resolves the configured exchange taker-fee ratio for a simulated order. */
export function resolveBacktestFeeRatio(params: {
  exchangeType?: ExchangeType;
  side: "buy" | "sell";
}): number {
  if (!params.exchangeType) {
    return BACKTEST_ONE_SIDE_FEE_RATIO;
  }

  return (
    getFeeCalculator(params.exchangeType).getTotalFeePercent({
      side: params.side,
      currency: "USDT",
      type: "taker",
    }) / 100
  );
}
