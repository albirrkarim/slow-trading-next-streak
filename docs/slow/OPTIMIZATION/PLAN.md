# SLOW Production Memory Optimization Plan

Status: engine reduction implemented; measurement and volatility optimization remain

Prepared: September 9, 2026

Target service: `Streak Grail : Two snake`

## A. Objective

Reduce Railway memory/minute cost by keeping the process near a low baseline,
allowing bounded spikes only while market data is processed, and preventing old
strategy data from remaining in the live object graph.

### A.1 Required Runtime Shape

```text
low idle baseline -> bounded volatility-work spike -> return near baseline
```

### A.2 Constraints

- Production and backtest must use the same entry engine.
- Account execution remains sequential and account state remains isolated.
- Persistent position, balance, and trade-history compatibility must remain.
- A low global `NODE_OPTIONS` heap limit is not the optimization; it also applies
  during Railway builds and already caused `npm install` to run out of memory.

## B. Phase 0 — Reduce Strategy Surface

Status: implemented.

### B.1 Keep Only `decision.v20`

The strategy registry and defaults now expose only `decision.v20`:

- [`src/lib/brain/algorithms/v4/decisions/index.ts`](../../../src/lib/brain/algorithms/v4/decisions/index.ts)
- [`src/lib/brain/algorithms/index.ts`](../../../src/lib/brain/algorithms/index.ts)
- [`src/lib/dynamic/constants.ts`](../../../src/lib/dynamic/constants.ts)
- [`src/components/constants.ts`](../../../src/components/constants.ts)

Engine implementations `v12` through `v19` were removed. The two generic
helpers still required by v20—entry-level validation and numeric scaling—now
live in
[`src/lib/brain/algorithms/v4/decisions/utils.ts`](../../../src/lib/brain/algorithms/v4/decisions/utils.ts).

### B.2 Remove Normalized-Price State

`decision.v20` selects entries only from the latest volatility point and the
configured minimum/maximum absolute levels. It does not consume normalized
price. Therefore the normalized-price generator, runtime field, storage file
API, dashboard feature, chart series, and backtest calculations were removed.

Relevant live-path evidence:

- [`src/lib/brain/algorithms/v4/decisions/v20/selection.ts`](../../../src/lib/brain/algorithms/v4/decisions/v20/selection.ts)
  reads only `volatilityPointsMap`, `minAbsLevelToEntry`, and
  `maxAbsLevelToEntry`.
- [`src/lib/slowTrading/cycle/shared-market.ts`](../../../src/lib/slowTrading/cycle/shared-market.ts)
  now prepares volatility and shared market access without constructing a
  second multi-symbol strategy history.
- [`src/lib/slowTrading/signals.ts`](../../../src/lib/slowTrading/signals.ts)
  passes volatility directly to the single recommendation engine.
- [`src/lib/slowTrading/cache.ts`](../../../src/lib/slowTrading/cache.ts)
  persists volatility only.
- [`src/lib/dynamic/backtest-volatility/index.ts`](../../../src/lib/dynamic/backtest-volatility/index.ts)
  defaults directly to v20 and no longer creates the removed history.

### B.3 Legacy Persistence Behavior

Old JSON may still contain a removed normalized-price field. The mode-state
normalizer drops that unknown field when loading/saving, so existing accounts
continue to load and the obsolete data disappears on the next state write.
The old standalone cache file is ignored; it is not read into process memory.

## C. Phase 1 — Measure Memory by Stage

Status: next recommended change.

### C.1 Evidence

[`src/lib/runtime/resource-monitor.ts`](../../../src/lib/runtime/resource-monitor.ts)
already reads cgroup usage, RSS, V8 heap, external memory, and ArrayBuffers.
[`src/lib/slowTrading/performance.ts`](../../../src/lib/slowTrading/performance.ts)
already records bounded per-stage duration summaries.

### C.2 Implementation

Add memory samples at these boundaries:

1. Before shared-market preparation.
2. After volatility assignment.
3. After each account finishes.
4. After cache persistence and mode-state save.
5. After the cycle becomes idle.

Persist only the latest compact summary and peak deltas. Do not append an
unbounded time series to mode memory.

### C.3 Acceptance

- Every completed cycle reports start, peak, end, and per-stage deltas for RSS,
  heap used, external memory, and cgroup usage.
- A 24-hour run does not grow the persisted measurement structure.
- Monitoring adds no market requests and does not change trading decisions.

## D. Phase 2 — Reduce Volatility Hydration

Status: planned after Phase 1 identifies the peak.

### D.1 Current Evidence

[`src/components/api/production/utils.ts`](../../../src/components/api/production/utils.ts)
loads per-symbol volatility JSON before trimming the active sequence.
[`src/lib/slowTrading/cache.ts`](../../../src/lib/slowTrading/cache.ts) reads and
merges durable volatility again before writing it.

### D.2 Implementation

Separate the bounded hot sequence used for trading from optional durable
history used for analysis. Load only the newest points needed by v20 into the
cycle. Keep any archival merge outside the entry-critical path.

### D.3 Acceptance

- Live recommendation results match the pre-change v20 results.
- Per-symbol hot volatility has an explicit maximum length.
- Runtime does not parse full archival histories on every entry cycle.
- Backtest dataset loading remains independent of live hot storage.

## E. Phase 3 — Stream Cold Volatility Initialization

Status: conditional.

### E.1 Trigger

Implement only if Phase 1 shows that missing/stale volatility initialization is
the dominant memory spike.

### E.2 Evidence

[`src/lib/dynamic/utils/volatility/engine.ts`](../../../src/lib/dynamic/utils/volatility/engine.ts)
may request months of klines for cold symbols.
[`src/lib/datasets/fetchKlines.ts`](../../../src/lib/datasets/fetchKlines.ts)
fetches in exchange-sized batches but currently joins those batches into one
result array.

### E.3 Implementation

Feed each fetched batch into the existing stateful volatility predictor and
release the batch before requesting the next one. Process cold symbols with a
small explicit concurrency limit.

### E.4 Acceptance

- Generated volatility points are identical for a fixed fixture.
- Peak RSS is materially lower for cold initialization across the production
  symbol count.
- Cancellation, rate limiting, retries, and cache writes still behave as before.

## F. Phase 4 — Process Isolation Fallback

Status: use only if bounded work still leaves an expensive RSS plateau.

Run cold initialization in a short-lived child process and return only compact
volatility state. Process exit is the reliable way to return all V8 and native
allocator pages to the operating system. This adds IPC and failure-handling
complexity, so measurement must justify it.

## G. Verification Matrix

### G.1 Required Checks Per Phase

```bash
npm run type
npm run quality
```

### G.2 Runtime Checks

- Production/live cycle.
- Sandbox cycle.
- Single- and multi-account execution.
- Quick backtest and full backtest.
- Warm and cold volatility caches.
- Redeploy overlap distinguished from single-container memory.

### G.3 Success Criteria

- Only `decision.v20` is callable.
- No normalized-price data is generated, loaded, persisted, or returned by an
  API.
- Comparable post-cycle memory floors do not rise monotonically.
- Heavy cold work produces a bounded spike whose owner is visible in stage
  measurements.
- Build memory remains unconstrained by a runtime-sized V8 heap cap.
