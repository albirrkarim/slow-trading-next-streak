interface ShouldExitParams {
  feeAdjustedNetProfitPercent: number;
  hasReachedVolatilityTarget: boolean;
  stopLossPercent?: number;
}

/**
 * Checks the tighter stop loss enabled after the shared volatility target hit.
 */
function shouldExit({
  feeAdjustedNetProfitPercent,
  hasReachedVolatilityTarget,
  stopLossPercent,
}: ShouldExitParams) {
  return (
    hasReachedVolatilityTarget &&
    Number.isFinite(stopLossPercent) &&
    stopLossPercent !== undefined &&
    stopLossPercent > 0 &&
    feeAdjustedNetProfitPercent <= -stopLossPercent
  );
}

const volatilityTargetStopLoss = {
  shouldExit,
} as const;

export default volatilityTargetStopLoss;
