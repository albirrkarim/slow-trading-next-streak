// USED Both backtest and production.
// So the result will be the same
// ========================================================

export const VOLATILITY_THRESHOLD = process.env.VOLATILITY_THRESHOLD
  ? parseInt(process.env.VOLATILITY_THRESHOLD)
  : 5; // in percent

const configuredVolatilityReversalThreshold = Number(
  process.env.VOLATILITY_REVERSAL_THRESHOLD,
);

// PROD:GLOBAL_VOLATILITY_REVERSAL_THRESHOLD
export const VOLATILITY_REVERSAL_THRESHOLD =
  Number.isFinite(configuredVolatilityReversalThreshold) &&
  configuredVolatilityReversalThreshold > 0
    ? configuredVolatilityReversalThreshold
    : 1; // in percent
