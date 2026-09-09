# Decision Engine

## A. Supported Engine

### A.1 Single Production and Backtest Engine

SLOW supports only `decision.v20`. Production, quick backtest, and full
backtest must use the same implementation.

Persisted configurations that contain an older engine name are normalized to
`decision.v20` when loaded. Removed engine implementations must not be restored
as fallback paths.

## B. Entry Inputs

### B.1 Required Data

The engine receives:

- the latest visible volatility points by symbol;
- `minAbsLevelToEntry`;
- `maxAbsLevelToEntry`;
- model and balance memory used for sizing.

It does not require a normalized-price series, latest-kline projection, speed
ranking, or classifier feature set.

### B.2 Level Gate

An entry point is actionable when all conditions hold:

1. `lvl` is finite.
2. `abs(lvl) >= minAbsLevelToEntry`.
3. `abs(lvl) <= maxAbsLevelToEntry`.
4. The point is the latest visible point for the symbol.
5. The point was not already used.

Defaults:

- minimum absolute level: `2`;
- maximum absolute level: `5`;
- minimum accepted configured value: `0`.

### B.3 Direction

- A bottom point (`B`) recommends `LONG`.
- A top point (`T`) recommends `SHORT`.
- BTC is context only and is not returned as an entry candidate.

## C. Allocation

### C.1 Recommendation Weight

The point level is scaled into `amountProbab`, bounded by the point probability
when present. The recommendation supplies a maximum leverage of `3`.

### C.2 Backtest Investment Amount

Backtest v20 divides available quote balance across returned recommendations,
applies each recommendation weight, and rejects an allocation below the
minimum trade amount.

### C.3 Production Investment Amount

Production evaluates the same level gate and then applies the live account
budget, worker, risk, volume, funding, late-entry drift, and execution guards.

## D. Diagnostics

### D.1 Required Codes

- `BTC_CONTEXT_ONLY`: BTC passed the level gate but cannot be entered.
- `USED_VOLATILITY_POINT`: the latest point was already consumed.
- `READY`: the latest unused point is inside the configured level range.

### D.2 Consistency

Diagnostics and executable recommendations must come from the same evaluation
so the dashboard never explains a different decision than production executes.

## E. Compatibility

### E.1 Persisted State

Removing old engines must not remove balances, positions, histories, pending
reentries, or volatility-point usage. Only obsolete strategy-specific fields
are ignored and removed on the next normalized save.

### E.2 Test Coverage

Changes to entry thresholds, direction mapping, allocation, or usage semantics
require both v20 unit coverage and production/backtest flow coverage.
