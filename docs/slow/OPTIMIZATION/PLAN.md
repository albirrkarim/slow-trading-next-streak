# SLOW Production Memory Optimization Plan

Status: proposed implementation plan

Prepared: September 9, 2026

Target service: `Streak Grail : Two snake`

This plan is specifically for reducing Railway memory/minute cost. The desired
shape is:

```text
low between-stage baseline -> bounded work spike -> return near baseline
```

The plan does not treat a low V8 heap limit as the solution. The observed
redeploy drop proves that process exit released the old resident set, while the
longer graph shows a stable warm plateau rather than a continuously rising
leak. The code evidence below shows several large, temporary object graphs and
copies that can expand the process before V8 or the native allocator retains
those pages for reuse.

## A. Decision Summary

### A.1 Recommended Order

Implement the work in this order:

1. **Phase 0 — attribute memory by SLOW stage.** Add low-overhead samples at
   explicit cycle boundaries using the resource monitor that already reads
   Railway cgroup memory, process RSS, V8 heap, external memory, and
   ArrayBuffers.
2. **Phase 1 — remove redundant full-data clones.** Transfer ownership where a
   local object is finished, keep the required per-account volatility copy,
   and share read-only price-normal input across accounts.
3. **Phase 2 — bound recurring storage hydration.** Stop parsing an aggregate
   all-symbol price-normal file and stop reloading full durable volatility
   history into the trading hot path.
4. **Phase 3 — reduce algorithmic temporary arrays.** Replace repeated
   filter/map/spread work in price-normal initialization with an equivalent
   rolling calculation.
5. **Phase 4 — stream cold-start klines.** Only if measurement shows the
   six-month volatility initialization is still a material peak, process one
   exchange batch at a time instead of collecting the whole range.
6. **Phase 5 — isolate the heavy phase in a child process.** Only if the first
   five phases reduce live objects but Railway RSS still keeps an expensive
   warm floor. Child-process exit is the reliable operating-system reclamation
   boundary.

### A.2 Why This Order Makes Sense

#### A.2.1 Measurement Comes First

Railway's service graph cannot distinguish JavaScript heap from native or
external memory. The repository already has the missing low-level reader, so
attribution is a small, low-risk change rather than a new monitoring system.

#### A.2.2 Copies Come Before Architecture Changes

The current cycle creates full JSON clones at multiple ownership boundaries.
Several of those copies are redundant because the source object is never used
again. Removing them is simpler and safer than immediately adding a worker or
changing storage format.

#### A.2.3 Storage Comes Before Forced Garbage Collection

Garbage collection can only reclaim objects after allocation. Reading less
data and constructing fewer copies prevents heap expansion in the first place.
`global.gc()` and a low `--max-old-space-size` do not guarantee that RSS pages
are returned to Railway.

#### A.2.4 Process Isolation Is a Measured Fallback

A short-lived child process will release its entire resident set when it exits,
but it adds build, IPC, failure-handling, and deployment complexity. It is
justified only if bounded in-process work still leaves a high RSS plateau.

### A.3 Non-Goals

- Do not change entry, exit, averaging, Black Swan, or classifier thresholds.
- Do not parallelize account execution. Accounts must remain sequential.
- Do not share mutable account state.
- Do not remove durable history merely to make the memory graph look smaller.
- Do not change backtest results.
- Do not use the old/new Railway deployment-overlap point as one process's
  memory peak.
- Do not set `NODE_OPTIONS=--max-old-space-size=128` globally. It already made
  `npm install` fail at build time and it does not cap total RSS.

## B. Code Evidence and Root-Cause Chain

### B.1 Existing Memory Attribution Is Available

| Evidence | What it proves |
| --- | --- |
| [`resource-monitor.ts:110-133`](../../../src/lib/runtime/resource-monitor.ts#L110) | `readMemory()` already reads cgroup usage plus process RSS, heap used/committed, external memory, and ArrayBuffers. |
| [`resource-monitor.ts:284-292`](../../../src/lib/runtime/resource-monitor.ts#L284) | The reader is already exposed through the grouped `resourceMonitor.memory.read` API. |
| [`instrumentation.ts:9-17`](../../../src/instrumentation.ts#L9) | The resource monitor already starts with the production server. |
| [`performance.ts:74-101`](../../../src/lib/slowTrading/performance.ts#L74) | SLOW already profiles named async sections and supports an injected observer. |
| [`performance.ts:103-143`](../../../src/lib/slowTrading/performance.ts#L103) | Completed cycles already persist a compact timing summary, so memory can follow the same bounded latest-summary pattern. |

Conclusion: Phase 0 is feasible without adding a third-party profiler or a
second monitoring daemon.

### B.2 Full JSON Cloning Amplifies Peak Memory

#### B.2.1 Clone Implementation

[`slowTrading/shared.ts:1-6`](../../../src/lib/slowTrading/shared.ts#L1) defines
the shared clone as:

```ts
JSON.parse(JSON.stringify(value))
```

For a large object graph, this temporarily holds the source object, the JSON
string, and the parsed destination. It is useful for true ownership isolation,
but expensive when the source can be transferred or safely read by reference.

#### B.2.2 Shared Volatility Is Copied Before the Source Dies

[`cycle/shared-market.ts:110-134`](../../../src/lib/slowTrading/cycle/shared-market.ts#L110)
does all of the following in the same function:

1. Builds `modelMemoryMap` for every selected symbol.
2. Loads/generates volatility into that map.
3. JSON-clones every symbol into `volatilityMemoryBySymbol`.
4. Builds `volatilityPointsMap` from the original map.

The original and cloned volatility graphs coexist. Because the local
`modelMemoryMap` does not escape `prepareUncached()`, the snapshot can take
ownership of those volatility objects without this first clone. A separate
per-account clone must remain because recommendation evaluation mutates
volatility-point fields and account state must stay isolated.

#### B.2.3 Shared Price-Normal History Is Copied Repeatedly

[`cycle/shared-market.ts:177-205`](../../../src/lib/slowTrading/cycle/shared-market.ts#L177)
builds and persists `sharedDynamicMemory.priceNormMapOverTime`. Immediately
afterward, [`cycle/shared-market.ts:264-271`](../../../src/lib/slowTrading/cycle/shared-market.ts#L264)
JSON-clones that full map into the returned snapshot.

Each account then clones the snapshot again in
[`cycle/index.ts:319-324`](../../../src/lib/slowTrading/cycle/index.ts#L319).
The alternative signal path has the same copy in
[`signals.ts:431-434`](../../../src/lib/slowTrading/signals.ts#L431).

Price-normal values are decision inputs. The decision code reads them with
operations such as `.at()` and `.filter()`; the shared stage is already
specified as immutable. This makes a read-only shared reference technically
possible, provided TypeScript types and tests prevent downstream mutation.

#### B.2.4 Recommendation Input Is Cloned Even After Account Isolation

[`signals.ts:464-479`](../../../src/lib/slowTrading/signals.ts#L464) sends a
JSON clone of `volatilityPointsMap` to recommendation evaluation. With shared
volatility already cloned into account-owned model memory at
[`cycle/shared-market.ts:65-81`](../../../src/lib/slowTrading/cycle/shared-market.ts#L65),
this additional whole-map clone may be unnecessary. It cannot be removed until
tests prove that evaluation mutations are intended to remain in the account's
model memory.

### B.3 Recurring Storage Reads Hydrate More Than the Hot Path Needs

#### B.3.1 Price-Normal Storage Is One Aggregate File

[`components/storage.ts:24-31`](../../../src/components/storage.ts#L24) maps all
symbols for one exchange to `priceNormMapOverTime.json`.

[`dynamic/utils/priceNorm.ts:115-133`](../../../src/lib/dynamic/utils/priceNorm.ts#L115)
parses the whole file, iterates every persisted symbol, and creates filtered
arrays. Only after that does the function inspect the requested symbols at
[`dynamic/utils/priceNorm.ts:137-154`](../../../src/lib/dynamic/utils/priceNorm.ts#L137).

Therefore an account using a subset of symbols still pays the parse/allocation
cost for every symbol ever retained in the aggregate file.

#### B.3.2 Volatility Is Split by Symbol but Durable History Is Re-expanded

[`production/utils.ts:78-86`](../../../src/components/api/production/utils.ts#L78)
reads the complete per-symbol volatility JSON before the runtime sequence is
pruned at [`production/utils.ts:120-140`](../../../src/components/api/production/utils.ts#L120).

The prediction engine itself keeps at most `LIMIT_VOLATILITY_POINT` points in
the normal path at
[`volatility/engine.ts:283-287`](../../../src/lib/dynamic/utils/volatility/engine.ts#L283),
and the current constant is 1,000. However,
[`slowTrading/cache.ts:17-33`](../../../src/lib/slowTrading/cache.ts#L17) reads
the full persisted file again, merges all historical points by id, writes the
expanded result, and only then removes runtime volatility from mode memory.

Conclusion: volatility storage is bounded in runtime only after the expensive
full read. Durable history and trading hot state need separate access paths.

### B.4 Cold Initialization Can Materialize Six Months of Klines

[`volatility/engine.ts:185-227`](../../../src/lib/dynamic/utils/volatility/engine.ts#L185)
requests six months when a symbol lacks enough recent state.
[`datasets/fetchKlines.ts:210-240`](../../../src/lib/datasets/fetchKlines.ts#L210)
already fetches that range in exchange-sized batches, but
[`datasets/fetchKlines.ts:311-338`](../../../src/lib/datasets/fetchKlines.ts#L311)
appends every batch to one `result` array before returning the whole array.

Streaming is feasible because the core predictor explicitly supports streaming
or batch use in
[`volatility/volatility.ts:204-238`](../../../src/lib/dynamic/utils/volatility/volatility.ts#L204),
and `predictor()` accepts and returns the small state needed for the next
candle. The batch detector currently wraps that primitive at
[`volatility/volatility.ts:460-511`](../../../src/lib/dynamic/utils/volatility/volatility.ts#L460).

### B.5 Price-Normal Cold Generation Repeats Array Work

[`dynamic/utils/priceNorm.ts:167-188`](../../../src/lib/dynamic/utils/priceNorm.ts#L167)
loops over every volatility-point timestamp. For each timestamp it calls
`cropVolatility()`, which filters and slices the source arrays, then
`updatePriceNorm()` maps prices and history again at
[`dynamic/utils/priceNorm.ts:35-70`](../../../src/lib/dynamic/utils/priceNorm.ts#L35).

The same result can be calculated with a rolling window of the last 100 visible
volatility points while keeping the existing strict time rule (`point.t <
currentTimeMs`). This removes repeated temporary arrays without changing the
formula.

### B.6 Known Collections Do Not Explain a Large Per-Cycle Leak

[`public-market-cache.ts:6-29`](../../../src/lib/slowTrading/public-market-cache.ts#L6)
expires completed values and caps the map at 256. Its in-flight promises are
deleted when settled at
[`public-market-cache.ts:37-50`](../../../src/lib/slowTrading/public-market-cache.ts#L37).

The Black Swan candle cache stores a maximum 70-candle request per key at
[`black-swan.ts:44-87`](../../../src/lib/slowTrading/black-swan.ts#L44). It does
not globally sweep removed symbol keys, so it deserves hygiene work, but its
payload size does not match the observed roughly 90-115 MB warm delta.

The initial optimization should therefore target temporary market-data graphs,
not the bounded public-market map.

## C. Phase 0 — Measure the Exact Allocation Owner

### C.1 Implementation

#### C.1.1 Reuse the Existing Reader

Export the memory sample type from
`src/lib/runtime/resource-monitor.ts` and continue using
`resourceMonitor.memory.read()`. Do not duplicate cgroup parsing inside SLOW.

#### C.1.2 Add Explicit Checkpoints

Add memory checkpoints at these boundaries:

1. Before shared storage/symbol loading.
2. After shared `assignVolatility()`.
3. After shared price-normal load/generation.
4. When the shared market snapshot is ready.
5. After each account finishes.
6. When the complete stage returns.

Do not read cgroup files around every small profiler section. Six explicit
checkpoints plus one per account are enough to attribute the large delta and
avoid turning diagnostics into measurable I/O overhead.

#### C.1.3 Persist Only a Compact Latest Summary

Extend the existing cycle performance summary with one latest-cycle memory
summary. Keep compact values in MB, for example:

```ts
interface SlowTradingCycleMemorySummary {
  start: RuntimeMemoryNumbers;
  peak: RuntimeMemoryNumbers;
  end: RuntimeMemoryNumbers;
  points: Array<{ s: SlowTradingMemorySection; m: RuntimeMemoryNumbers }>;
}
```

Persist only the latest successful stage summary, as the timing profiler does.
Do not append an unlimited in-process sample history. Railway remains the
long-term time-series source.

#### C.1.4 Classify the Result

Use the samples to choose the next action:

| Observed change | Interpretation | Next action |
| --- | --- | --- |
| `heapUsed` jumps with volatility or price-normal work | Large live JS graph | Execute Phases 1-4 in measured order. |
| `heapUsed` falls but `heapTotal`/RSS stay high | V8 committed-page retention | Reduce peak first; consider Phase 5 if cost remains high. |
| `external` or `arrayBuffers` jumps | Buffer/native payload owner | Trace the corresponding exchange/HTTP section before changing JS collections. |
| cgroup usage rises much more than process RSS | Another process or deployment overlap | Correlate deployment/build processes; do not blame the SLOW server heap. |

### C.2 Files

- `src/lib/runtime/resource-monitor.ts`
- `src/lib/slowTrading/performance.ts`
- `src/lib/slowTrading/cycle/coordinator.ts`
- `src/lib/slowTrading/cycle/shared-market.ts`
- `src/lib/slowTrading/stage-run.ts`
- `src/lib/slowTrading/types.ts`

### C.3 Tests

- Extend `src/__dev__/main/quality/unit/resource-monitor.test.ts` for exported
  sample normalization and category deltas.
- Extend
  `src/__dev__/main/quality/performance/slow-cycle-duration.test.ts` with an
  injected deterministic memory reader.
- Assert checkpoint order and compact latest-summary persistence.
- Do not assert absolute RSS in CI; operating-system memory is nondeterministic.

### C.4 Acceptance Gate

Do not start storage migration until at least one `capture-entry` stage on the
target service identifies the largest of:

- volatility load/generation delta;
- price-normal load/generation delta;
- per-account clone/execution delta;
- native/external delta.

## D. Phase 1 — Remove Redundant Full-Graph Copies

### D.1 Phase 1A — Safe Ownership Transfers

#### D.1.1 Volatility Snapshot Construction

In `prepareUncached()`, move each locally created volatility object from
`modelMemoryMap` into `volatilityMemoryBySymbol` instead of JSON-cloning it.
Build `volatilityPointsMap` from that same snapshot-owned graph. The local model
map does not escape, so no competing owner remains.

Keep `attachVolatility()` cloning snapshot volatility into each account. That
copy enforces the `CYCLE.md` immutable-shared-market and mutable-private-account
contract.

#### D.1.2 Price-Normal Snapshot Construction

Return `sharedDynamicMemory.priceNormMapOverTime` directly after its final
update/write rather than JSON-cloning it into the snapshot. No code in
`prepareUncached()` modifies it after snapshot construction.

#### D.1.3 Expected Result

This removes one full volatility serialization/parse and one full price-normal
serialization/parse from every shared market preparation. It does not change
storage or trading output.

### D.2 Phase 1B — Read-Only Sharing Across Accounts

#### D.2.1 Add an Explicit Read-Only Market Input

Type snapshot price-normal history as a deeply read-only market input. Pass
that input to recommendation evaluation without assigning a cloned copy into
each account's mutable `dynamicTradeMemory`.

If an existing function genuinely needs to update price-normal history, keep
that update in the single shared preparation phase. Account execution must
only read the finalized shared map.

#### D.2.2 Remove the Recommendation Clone Only After Parity Tests

Pass the already account-owned `volatilityPointsMap` to recommendation
evaluation directly. Evaluation writes temporary fields such as `delta`,
`feature`, and probability to current points, so tests must confirm those
writes are either intended account state or are moved into a smaller local
evaluation object.

#### D.2.3 Preserve Sequential Account Isolation

The coordinator must continue to prepare one shared snapshot and process
accounts sequentially, as implemented at
[`cycle/coordinator.ts:116-159`](../../../src/lib/slowTrading/cycle/coordinator.ts#L116)
and required by [`CYCLE.md`](../SPECS/CYCLE.md). Phase 1 must not introduce
parallel private exchange calls or cross-account mutable model memory.

### D.3 Files

- `src/lib/slowTrading/cycle/shared-market.ts`
- `src/lib/slowTrading/cycle/index.ts`
- `src/lib/slowTrading/signals.ts`
- `src/lib/slowTrading/cycle/types.ts`
- Decision input types under `src/lib/brain/algorithms/v4/decisions/**`

### D.4 Tests

- One shared snapshot for multiple accounts.
- An evaluation mutation in account A cannot appear in account B.
- Live and sandbox memories remain isolated.
- Recommendation diagnostics and selected signals match fixtures before and
  after the change.
- Persisted cache and mode-state JSON remain semantically identical.

### D.5 Acceptance Gate

- Phase 0 reports fewer/lower allocation deltas at snapshot creation and each
  account start.
- The complete existing quality suite passes.
- A deterministic multi-account fixture produces the same reports, positions,
  balances, point-usage flags, and diagnostics.
- If output parity cannot be proven for a clone, retain that clone and continue
  with the other independently safe transfers.

## E. Phase 2 — Bound Hot Storage Hydration

### E.1 Price-Normal Data by Symbol

#### E.1.1 Target Shape

Replace recurring reads of:

```text
slow/<exchange>/priceNormMapOverTime.json
```

with requested-symbol files such as:

```text
slow/<exchange>/price-norm/BTC.json
slow/<exchange>/price-norm/SUI.json
```

Each file remains compact JSON and retains the existing six-month time window.
Read only the normalized union of the stage's requested symbols, including BTC
when it is required as market context.

#### E.1.2 Compatibility Rollout

Use a two-release migration so an old and new Railway deployment may overlap
safely:

1. **Compatibility release:** add a grouped price-normal storage API that reads
   symbol files first, falls back to the legacy aggregate file, and writes both
   formats. Backfill symbol files atomically.
2. **Cutover release:** after every reader uses the grouped API, write only
   symbol files. Keep legacy aggregate read fallback for rollback, but do not
   parse it during normal operation when symbol files exist.
3. **Cleanup release:** remove the legacy aggregate only after a verified
   backup and at least one successful rollback window.

The one-time backfill may parse the aggregate file once. The optimization is
that normal future stages never parse it again.

#### E.1.3 Atomicity

Use the existing atomic replacement API in
[`storage/json-file.ts:25-63`](../../../src/lib/slowTrading/storage/json-file.ts#L25).
Do not add direct partial writes. Serialize writes per symbol and use bounded
concurrency so a large symbol universe does not create all write payloads at
once.

### E.2 Separate Volatility Hot State from Durable History

#### E.2.1 Hot-State Rule

The trading file should contain the exact volatility memory left by the current
runtime after `predictionEngine()` and `pruneVolatilityPoints()` complete,
including `vPointLastUpdate` and other prediction metadata. Do not merge older
archive-only points back into this hot file.

This preserves the current runtime contract: the prediction engine applies the
existing `LIMIT_VOLATILITY_POINT` rule before the active-position-aware prune.
The storage refactor must not apply a second, smaller hard slice. If consumer
tracing or a regression fixture shows that an active position requires a point
outside the current runtime output, retain that required suffix explicitly
rather than discarding it.

#### E.2.2 Durable-History Rule

Move older points into on-demand per-symbol/per-month history files. Dashboard
or maintenance APIs may combine hot plus archive data when full history is
explicitly requested. The runner must read only hot state.

This follows the already implemented closed-trade history pattern documented
at [`RUNTIME.md`](../SPECS/RUNTIME.md), where normal runner loads do not hydrate
all archived positions.

#### E.2.3 Persistence Rule

Replace `mergeVolatilityMemoryById(fullPersisted, runtime)` in the hot cycle
with a grouped storage operation that:

1. Reads the current hot file only.
2. Merges used flags/new points by id.
3. Calculates the required hot suffix.
4. Atomically archives displaced older points.
5. Atomically writes the compact hot file.
6. Deletes volatility from mode memory exactly as the current cache persistence
   step does.

Never discard a point referenced by an active position or needed for entry
usage deduplication.

### E.3 Files

- `src/components/storage.ts`
- New grouped module under `src/lib/slowTrading/storage/market-memory.ts`
- `src/lib/slowTrading/storage/json-file.ts`
- `src/components/api/production/utils.ts`
- `src/lib/slowTrading/cache.ts`
- `src/lib/slowTrading/cycle/shared-market.ts`
- Dashboard/initialize/alter APIs that currently read the legacy files

### E.4 Tests

- Legacy aggregate price-normal fallback.
- Idempotent aggregate-to-symbol migration.
- Old/new dual-write compatibility.
- Requested-symbol read does not hydrate an unrelated large symbol fixture.
- Volatility hot/archive split and combined on-demand read.
- Point `used`, `usedByMain`, and `usedByCounter` mutations survive persistence.
- Hot persistence contains every point present in the current post-prediction,
  post-prune runtime result, including the active-position-required suffix.
- A closed position allows old hot points to move to archive.
- Atomic-write interruption leaves either the previous or complete next file.

### E.5 Acceptance Gate

- Normal `capture-entry` reads scale with requested symbols and required hot
  points, not total historical symbols/points.
- No persisted trading or dashboard data is lost.
- A rollback release can still read the legacy format during the migration
  window.
- Phase 0 shows a lower volatility/price-normal hydration peak.

## F. Phase 3 — Remove Repeated Temporary Arrays

### F.1 Rolling Price-Normal Initialization

Replace the per-timestamp `cropVolatility()` filter/slice loop with a rolling
window that contains exactly the last 100 points whose timestamps are strictly
less than the current point timestamp. Calculate min/max with loops rather than
creating `prices`, `oneYear`, and mapped min/max arrays on every iteration.

### F.2 Preserve Numerical Behavior

The replacement must preserve:

- strict `< currentTimeMs` visibility during historical initialization;
- the last-100 volatility-point limit;
- the six-month price-normal retention window;
- `toFixed(2)` normalization behavior;
- duplicate prevention by timestamp;
- BTC context and every decision-engine version.

### F.3 Backtest Boundary

This code lives under `src/lib/dynamic/**`, which is shared with backtest. Use a
pure calculation helper and run the old and new algorithms against the same
fixtures before switching callers. This phase is an allocation refactor, not a
production-only change to calculated data.

### F.4 Files and Tests

- `src/lib/dynamic/utils/priceNorm.ts`
- Existing price-normal unit/backtest tests plus a new parity fixture covering
  duplicate timestamps, the 100-point boundary, and the six-month cutoff
- Production cycle fixture confirming identical recommendations

### F.5 Acceptance Gate

- Deep-equal price-normal outputs for fixed fixtures across all supported
  decision engines.
- Lower `signals.priceNorm` peak and duration on a representative 1,000-point,
  multi-symbol fixture.
- No change to backtest trade count, ordering, or PnL for the selected
  regression dataset.

## G. Phase 4 — Stream Six-Month Cold Initialization

### G.1 Trigger

Implement this phase only when Phase 0 still identifies cold
`assignVolatility()` as a material peak after Phase 2. Warm cycles that fetch a
small recent range do not need this complexity.

### G.2 Design

#### G.2.1 Batch Consumer

Extract the existing fetch-loop retry/rate-limit behavior so production can
consume each exchange batch without appending it to one six-month `result`
array. Keep the current collecting API for backtest and existing callers.

#### G.2.2 Streaming Detector State

Create a grouped streaming volatility detector that carries:

- `PredictorMemory`;
- previous point label and volatility level;
- the bounded output volatility-point suffix;
- the final kline timestamp.

Feed batches in chronological order and discard each candle batch after it is
processed. The existing pure `predictor(kline, memory)` is the algorithmic
foundation, so this does not require a different volatility formula.

#### G.2.3 Failure Behavior

A failed batch must fail the shared market stage according to `CYCLE.md`.
Do not silently retry the whole six-month range through a second code path,
because that could duplicate exchange requests and recreate the memory peak.

### G.3 Tests

- Batch detector output is deep-equal to the current whole-array detector.
- A pivot spanning two batch boundaries is identical.
- Retry and rate-limit behavior remains unchanged.
- Maximum simultaneously retained candles is at most one exchange batch plus
  small overlap/state.
- Backtest continues using its current deterministic input path.

### G.4 Acceptance Gate

- Cold-start peak no longer scales with the complete six-month candle count.
- Volatility point ids, times, labels, levels, prices, and volumes are identical
  to the current detector for the same candles.

## H. Phase 5 — Child-Process Isolation if RSS Still Stays Warm

### H.1 Trigger

Use a child process only if all of the following are true:

1. Phase 0 proves that large objects become unreachable after shared market
   preparation.
2. Phases 1-4 materially reduce `heapUsed` or live-data size.
3. Railway process RSS still remains materially above the fresh baseline for
   multiple idle stage intervals.
4. The remaining memory/minute saving is worth the operational complexity.

### H.2 Boundary

Move only public, allocation-heavy market preparation into the child:

- bounded volatility hot-state reads;
- public kline retrieval and volatility calculation;
- price-normal calculation;
- compact immutable snapshot creation.

Keep private account calls, balances, order execution, mutation ordering,
notifications, and mode persistence in the parent. The parent continues to
process accounts sequentially.

### H.3 Packaging

Add a dedicated worker build artifact and include it explicitly in Next
standalone output tracing. Do not depend on `tsx` or other dev-only tooling at
runtime. Verify the artifact exists inside `.next/standalone` as part of
`npm run build:railway`.

### H.4 IPC and Failure Safety

- Send a compact request containing exchange/market, normalized symbols,
  cutoff, and public configuration.
- Return one versioned JSON-safe snapshot.
- Set a timeout and maximum IPC payload size.
- Validate the response before any account executes.
- On child failure, fail the shared stage once and notify. Do not execute
  accounts with a partial snapshot.
- Do not silently fall back to the in-process heavy path in the same stage.

### H.5 Acceptance Gate

- Parent RSS returns close to its between-stage baseline after the child exits.
- Trading outputs match the in-process reference fixture.
- Child crash, timeout, malformed response, and deployment artifact tests pass.
- Railway shows that the lower memory/minute baseline offsets the extra child
  startup work.

## I. Phase 6 — Small Cache Hygiene

### I.1 Black Swan Candle Cache

Add an expired-entry sweep and a maximum key count to `candleCache` in
`src/lib/slowTrading/black-swan.ts`. Sweep before lookup/insert and expose only
counts for diagnostics. This prevents removed symbols from leaving small stale
entries for the life of the process.

### I.2 Existing Bounded Caches

Keep the current public-market cap and single-flight cleanup. Add regression
tests rather than replacing a cache that already has explicit eviction.

### I.3 Priority

This is correctness and hygiene work, not the primary 90-115 MB optimization.
Implement it after measured large-object work unless Phase 0 contradicts the
current size assessment.

## J. Verification Matrix

### J.1 Automated Checks Per Phase

Every implementation phase must pass:

```bash
npm run type
npm run quality
```

Add targeted tests before running the full gate. Storage or calculation phases
also require fixture-level compatibility tests.

### J.2 Behavior Matrix

| Flow | Required proof |
| --- | --- |
| Production live | Same sequential private execution, balances, reports, and persistence. |
| Production sandbox | Same simulated balances, positions, and point-usage state. |
| Multi-account | One shared public snapshot; no mutable state crosses accounts. |
| Backtest | Same deterministic signals/trades/PnL for regression fixtures. |
| Empty monitoring | Still performs no unnecessary market I/O. |
| Black Swan | Recovery and emergency-exit behavior unchanged. |
| Storage rollback | Previous release can read data throughout the compatibility window. |

### J.3 Railway Measurement Protocol

Compare equivalent stage windows, not deployment boundaries:

1. Record the fresh post-deploy baseline after the old container has drained.
2. Record memory checkpoints for at least six equivalent `capture-entry`
   stages.
3. Record the between-stage baseline 10-15 minutes after each stage.
4. Separate cgroup usage from process RSS and exclude old/new overlap.
5. Compare the same account count, symbol set, trading mode, and stage type.
6. Repeat after each phase; do not combine all phases before measuring.

### J.4 Quantitative Success Criteria

Use the September 9 observation as the initial reference, then replace it with
Phase 0's exact baseline:

- Fresh process reference: approximately `85-105 MB`.
- Old warm plateau reference: approximately `149-165 MB`, with earlier points
  near `195-205 MB`.
- Primary target: comparable between-stage RSS/cgroup usage returns to within
  `20 MB` of the fresh steady baseline.
- Stability target: the comparable between-stage floor does not rise by more
  than `10 MB` across six equivalent cycles.
- Peak target: each optimized section's delta is lower than its Phase 0
  baseline and remains bounded as unrelated persisted symbols/history grow.
- Correctness target: zero differences in deterministic signals, execution
  reports, balances, position state, and persisted compatibility fixtures.

These are go/no-go targets, not claims that the code already achieves them.

## K. Rollback Rules

### K.1 Phase 0

Disable detailed SLOW memory checkpoints with one runtime flag while leaving
the existing resource alert monitor active.

### K.2 Phase 1

Restore only the clone whose isolation test fails. Ownership-transfer changes
are independent and should not be rolled back as one large bundle.

### K.3 Phase 2

Keep the legacy read fallback and backup through the full rollout window. A
rollback must never depend on reconstructing deleted history.

### K.4 Phases 3 and 4

Keep reference algorithms behind test-only comparison helpers until parity is
proven. Roll back on any output mismatch, even if memory improves.

### K.5 Phase 5

Use a runtime feature flag to select the child-process path between stages. Do
not switch execution mode during an active stage.

## L. Implementation Checkpoints

### L.1 Checkpoint 1 — Evidence

- [ ] Stage memory samples are visible and attributable.
- [ ] One target-service `capture-entry` cycle has been captured.
- [ ] Largest allocation owner is named from evidence, not assumed.

### L.2 Checkpoint 2 — Copy Reduction

- [ ] Snapshot ownership-transfer tests pass.
- [ ] Account isolation tests pass.
- [ ] Clone-related memory delta is lower.

### L.3 Checkpoint 3 — Hot Storage

- [ ] Price-normal requested-symbol read is live.
- [ ] Volatility hot/archive split is compatible and atomic.
- [ ] Normal runner load does not hydrate durable market history.

### L.4 Checkpoint 4 — Calculation Allocation

- [ ] Rolling price-normal calculation is output-identical.
- [ ] Cold volatility streaming is implemented only if measurement requires it.
- [ ] Production and backtest regression outputs match.

### L.5 Checkpoint 5 — Railway Outcome

- [ ] Six equivalent cycles meet the stability target.
- [ ] Between-stage memory approaches the fresh-process baseline.
- [ ] If not, Phase 5 evidence and cost justification are documented.

## M. Final Recommendation

Start with **Phase 0 and Phase 1A in the first implementation change**. They use
existing APIs, do not change persisted data, and provide immediate evidence
plus removal of two clearly redundant full-data clones.

Use Phase 0 results to choose whether price-normal or volatility storage moves
first in Phase 2. Do not deploy the child-process architecture until the data
shows that lower live-object size still fails to lower Railway's between-stage
resident baseline.

The highest-confidence optimization chain is therefore:

```text
measure category/stage
  -> stop redundant serialization clones
  -> stop recurring full-data hydration
  -> reduce temporary-array algorithms
  -> stream exceptional cold starts
  -> isolate in a disposable process only if allocator retention remains
```

That chain directly targets memory/minute cost while preserving the SLOW
trading and persistence contracts.
