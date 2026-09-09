# SLOW Production Optimization

This document tracks how to keep the SLOW Railway deployment clean, efficient, and production-focused.

## A. Optimization Assessment — 82/100

Assessment date: September 9, 2026.

The current SLOW production shape is reasonably optimized for a small Railway
deployment. Dev/backtest routes are guarded, the `/slow` dashboard is client
lazy-loaded, runtime storage loads only the active mode, closed trade history is
split out of normal memory, and several runtime caches are persisted outside the
hot storage object. Completed SLOW stages also persist a compact section-duration
breakdown, making the slowest operation visible from the dashboard. The remaining
optimization gap is mostly bounded measurement: there is no regular memory
budget report, no bundle-size budget, and no production-like load test that
proves the memory cap is safe across larger symbol or account counts. Railway
redeploy evidence now confirms a material process-lifetime warm-memory delta,
while the longer series shows reclamation and plateaus rather than a monotonic
leak. The remaining gap is attributing that delta to V8 heap, native/external
memory, or specific bounded caches with stage-level samples or a heap profile.

The score increased from 78 because cycle timing is now observable and tested,
the full standalone liquidation-map feature was removed, and every current dev
page/API has an explicit production guard. The score reflects architecture and
operational safety, not a measured percentage reduction: peak memory, client
bundle size, and production-scale throughput have not yet been benchmarked.

### A.1 Assessment Evidence

This assessment is based on the repository state and verification available on
September 9, 2026:

- `next.config.ts` uses `output: "standalone"`, disables production browser
  source maps, removes the powered-by header, and excludes persistent storage
  from output tracing.
- All three current dev pages and all five current dev API routes call the shared
  `isDevBacktestEnabled()` guard.
- Dev API route shells dynamically import their heavy implementations only
  after the guard passes.
- Normal SLOW cycle, runner, withdrawal, queue, and MCP paths request active-mode
  storage where applicable.
- Closed history is split by symbol and normal runtime state strips archived
  `positionsSell` rows.
- The standalone liquidation-map route, API, components, model, tests, and docs
  are absent, while core trading liquidation behavior remains.
- `npm run quality` passed with 128 test files and 732 tests.

No heap profile, route-chunk report, or controlled production-like load sample
has been captured. Those missing measurements cap the score.

### A.2 Railway Redeploy Memory Finding — September 9, 2026

A Railway observability screenshot and MCP metrics for the production `Streak
Grail : Two snake` service show a clear process-replacement boundary. The
deployment began at `2026-09-09 00:52:28 UTC` (`07:52:28 GMT+7`) and reached
`SUCCESS` at `00:54:02 UTC`.

- Immediately before the visible replacement boundary, the old container was
  using approximately `195-205 MB`.
- After the old container drained, the replacement process used approximately
  `85-105 MB`; the screenshot tooltip reports `103 MB` at `07:56 GMT+7`.
- Railway's downsampled service series reports `315 MB` at `00:53 UTC`, exactly
  while the old and new deployments overlapped. This is aggregate service
  memory from both deployments, not a valid single-process peak.
- The previous deployment's longer series did not rise continuously. It
  reclaimed from roughly `218 MB` to `148 MB`, then stayed near `149-165 MB`
  for hours before the redeploy.
- The new process stabilized near `100-105 MB` after deployment.
- No OOM kill, crash, restart loop, or memory-pressure event appears in the
  deployment history or searched runtime logs.

Railway singleton deployments have a slight old/new overlap for zero downtime,
and configurable overlap can extend it. Therefore, never use the aggregate
memory point at the deployment boundary as one container's peak. See Railway's
[singleton deployment reference](https://docs.railway.com/deployments/reference#singleton-deploys)
and [zero-downtime redeploy documentation](https://docs.railway.com/guides/rotate-credentials-zero-downtime#make-the-redeploy-itself-zero-downtime).

#### A.2.1 What the Drop Proves

The drop proves that the old process had a larger warm resident set that was
released only when that process exited. In operational terms, there was about
`90-115 MB` more process-lifetime memory in the old container than in the fresh
container shown in the screenshot.

It does **not** prove that `90-115 MB` consisted of unreachable JavaScript
objects. Railway reports cgroup/container memory, which combines live V8 heap,
V8 committed-but-currently-unused pages, loaded Next.js/module code, native
allocations, HTTP/TLS buffers, external memory, and intentional caches. A
redeploy releases all of those categories together.

#### A.2.2 Leading Cause from the Code Audit

The leading explanation is **transient SLOW-cycle allocation followed by V8
and native allocator retention**, with smaller intentional process caches. The
hot production path performs several allocation-heavy operations:

- `assignVolatility()` reads persisted volatility JSON for every selected
  symbol. When a symbol lacks enough recent state, `predictionEngine()` can
  fetch and process up to six months of klines.
- `cycle/shared-market.ts` builds volatility maps and per-account snapshots
  during one stage.
- The obsolete v12-v19 engines and their normalized-price history were removed
  on September 9, 2026. That eliminates one known multi-symbol allocation tree;
  the remaining leading candidate is volatility/kline hydration and cloning.
- Finalization removes volatility from persisted hot mode state. Garbage
  collection still does not require V8 or the native allocator to return freed
  pages to the operating system immediately.

This allocation/reuse pattern fits the observed graph better than a classic
unbounded object leak: the old process reclaimed tens of megabytes during its
lifetime and then held a stable floor for hours. The sibling services also hold
different stable warm floors, consistent with different process age, symbol
sets, position state, and stage timing.

The repository audit did not find a process-lifetime collection that obviously
explains a `90-115 MB` unbounded increase:

- The public-market completed cache expires entries and is capped at 256; its
  in-flight operations are deleted when settled.
- The funding-rate cache holds one replaceable all-symbol snapshot per market.
- Black-swan candle cache entries hold at most the requested short 70-candle
  window per touched exchange/market/symbol key. Removed symbols are not swept,
  so this is cleanup debt, but each retained value is small.
- Exchange-info, request-weight, balance-alert, and market-cap maps grow by a
  bounded domain/symbol/account key rather than by runner cycle.
- Runner, mutation, and JSON-write promise chains replace or delete settled
  work and do not retain completed cycle results.

At the time of this `Streak Grail : Two snake` observation, the service had
`MEMORY_MONITOR_WARNING_MB=150` and `MEMORY_MONITOR_DANGER_MB=430`, but no
`NODE_OPTIONS` variable. Consequently, no explicit V8 old-space cap was active
during this observation. That absence does not itself explain the warm resident
floor: a heap cap limits allocation but does not require V8 or the native
allocator to return resident pages. The monitor also only alerts; it does not
release memory.

#### A.2.3 Root-Cause Status

```text
Confirmed cause of the vertical drop:
  old Railway container exited and its complete resident set was reclaimed

Confirmed cause of the 315 MB boundary sample:
  old/new deployment overlap aggregated at service level

Leading cause of the old container's higher stable floor:
  large transient volatility/kline allocations expanded the
  process heap; V8/native allocators retained reusable pages, plus bounded caches

Not proven:
  an unreachable JavaScript-object leak that grows on every cycle
```

The important distinction is:

```text
Allocator warm-up/retention: memory rises after heavy work, can partially fall,
then oscillates around a stable reusable plateau.

Object leak: the comparable post-GC floor keeps rising across equivalent runner
cycles and does not return to a previous plateau.
```

Treat the current runtime memory posture as **warm resident memory confirmed;
unbounded leak not demonstrated**. Do not infer one process's peak from the
redeploy-overlap sample, and do not lower memory limits until stage-level heap,
RSS, external, and cgroup measurements identify which category establishes the
warm floor.

The main rule:

```text
Production should only ship and run the SLOW dashboard, SLOW APIs, auth, storage, exchange execution, and notification logic.
Development backtest pages/APIs should not be available or loaded in Railway production unless explicitly enabled.
```

## B. Goals

- Keep Railway memory stable and low.
- Keep the standalone production bundle focused on `/slow`.
- Avoid accidental production access to heavy dev/backtest tools.
- Keep dev/backtest tools available locally.
- Make optimization decisions based on real runtime impact, not only build output cosmetics.

## C. Current Production Target

Railway production should run the standalone Next.js server:

```bash
node .next/standalone/server.js
```

Recommended Railway environment:

```bash
HOSTNAME=0.0.0.0
PORT=8080
NODE_ENV=production
NEXT_TELEMETRY_DISABLED=1
PERSISTENT_STORAGE_ROOT=/storage/persistent/instances/3010
```

### C.1 Heap Limits Are Not a Flat-Memory Solution

Do not set a low service-wide `NODE_OPTIONS` value as the memory optimization.
Railway exposes service variables to the build as well as the running service.
On September 9, 2026, setting the following value caused the `Holy Grail : Sub
Machine gun` deployment to fail during `npm install`:

```bash
NODE_OPTIONS=--max-old-space-size=128 --max-semi-space-size=4
```

The build log reached approximately `127 MB` of V8 heap and terminated with
`Reached heap limit Allocation failed - JavaScript heap out of memory`. This is
a build-time failure caused by applying a runtime-sized heap limit to the npm
installer.

If a heap ceiling is needed as a runtime safety experiment, remove the global
`NODE_OPTIONS` variable and put the flags directly on Railway's custom start
command:

```bash
node --max-old-space-size=128 --max-semi-space-size=4 .next/standalone/server.js
```

This keeps installation and `next build` unrestricted while limiting only the
standalone server. It must still be tested through every SLOW stage because a
128 MB old-space limit can cause a runtime OOM. It also does **not** cap total
Railway memory or guarantee a lower flat line: total RSS includes young
generation, committed free heap pages, loaded code, native allocations,
external buffers, and runtime overhead.

Treat runtime heap flags as a crash-containment guardrail, not as evidence that
the cost problem is solved. Forced garbage collection has the same limitation:
it may make objects collectible without returning the process's resident pages
to the operating system.

### C.2 Memory-Cost Target

Railway bills actual memory over time, so the desired profile is:

```text
low idle baseline -> short stage spike -> return close to the idle baseline
```

Achieving that profile requires reducing or isolating the allocation source:

1. Stop reading and cloning complete volatility and price-normal datasets when
   a stage needs only selected symbols and a bounded time window.
2. Measure cgroup, RSS, heap used/committed, external memory, and ArrayBuffers
   before and after each SLOW stage to identify the allocation owner.
3. If V8/native memory still holds the higher floor after references are
   released, move the allocation-heavy market-preparation work into a
   short-lived child process. Process exit is the reliable boundary that makes
   the operating system reclaim those pages after the spike.

Success must be measured by the comparable between-stage Railway baseline, not
by avoiding an OOM or lowering `heapUsed` alone.

## D. Dev/Backtest Exclusion

The backtest page is useful locally but should not be part of normal Railway production behavior:

```text
/dev/dynamic-trade
/dev/coins
/dev/vpoints
/api/dev/dynamic-trade
/api/dev/dynamic-trade/leaderboards
/api/dev/coins
/api/dev/coin-tags
/api/dev/vpoints
```

These routes are not expected to consume a large amount of idle memory just because they exist in the build. Next.js usually loads route code when the route is requested. However, excluding or guarding them still matters because it:

- Prevents accidental production access to expensive backtest execution.
- Reduces production bundle and standalone trace noise.
- Makes the deployed app easier to reason about.
- Avoids dev UI imports leaking into the `/slow` production client bundle.

## E. Implemented Controls

Production now uses one shared server-side dev-backtest guard:

```ts
isDevBacktestEnabled()
```

The guard is enabled when **any one** of these conditions is true:

```text
NODE_ENV !== production
ENABLE_DEV_BACKTEST=1
NEXT_PUBLIC_ENABLE_DEV_BACKTEST=1
```

`NEXT_PUBLIC_ENABLE_DEV_BACKTEST` is a public build/runtime toggle, not an
authentication boundary. A production deployment that enables dev backtests
must still be access-controlled at the deployment or network layer.

Implemented behavior:

- `/dev/dynamic-trade`, `/dev/coins`, and `/dev/vpoints`
  are force-dynamic and return `notFound()` in production unless dev backtest
  is enabled.
- `/api/dev/dynamic-trade` is a tiny route stub that returns `404` in production unless dev backtest is enabled.
- `/api/dev/dynamic-trade/leaderboards` is a tiny route stub that returns `404` in production unless dev backtest is enabled.
- `/api/dev/coins`, `/api/dev/coin-tags`, and
  `/api/dev/vpoints` return `404` in production unless dev backtest is enabled.
- Heavy dev API implementations live outside `src/pages/api` under `src/lib/devBacktest/api`.
- Heavy dev API implementations are dynamically imported only after the API guard passes.
- The vPoint page dynamically imports its tuner UI only after its page guard
  passes.
- The Dynamic Trade and Coins pages still use static imports in
  their own guarded route modules. Next.js keeps these out of the `/slow` route
  chunk, but they remain candidates for post-guard dynamic imports if a future
  bundle report shows meaningful standalone or build-size savings.
- The development links remain visible in the shared sidebar. In a normal
  production deployment their guarded destinations return not found.

Next.js will still list the `/api/dev/*` routes during build because route files still exist. That is acceptable: the production-built route files are intentionally small guard shells. The heavy backtest code is not loaded into memory unless the endpoint is explicitly enabled and requested.

Enabling dev backtests in production is an explicit operational override. These
tools are expensive and should not be exposed on a public deployment merely for
convenience.

## F. Production UI Boundaries

The production dashboard is lazy-loaded from a client wrapper:

```ts
const LiveDashboardPage = dynamic(() => import("./LiveDashboardPage"), {
  ssr: false,
});
```

The former standalone liquidation-map feature has also been removed cleanly:

- No `/liquidation` or `/liquidation/[symbol]` page.
- No `/api/liquidation-map` endpoint.
- No liquidation-map model, chart, or page component bundle.
- Core exchange liquidation prices and trading liquidation handling remain in
  place; only the standalone visualization feature was removed.

Some coin metadata controls used by `/slow` still live under
`src/components/dev/Coins`. They are small shared production controls, not the
coin-finder backtest itself. Moving them to a neutral shared directory would
make the module boundary clearer, but it is not currently a demonstrated memory
problem.

## G. Runtime Performance Visibility

Each completed SLOW cycle or scheduled stage now records:

- Total duration in milliseconds.
- Per-section total duration and invocation count.
- The number of processed symbols and generated reports for scheduled stages.
- A compact persisted summary sorted by the slowest section first.

The navbar stage-run view exposes this breakdown so an operator can identify
whether signal generation, exchange synchronization, execution, cache writes,
or mode persistence is the current bottleneck. The quality suite also verifies
that timed sections are recorded and that the intentionally delayed leaf step
appears as the slowest section.

This is diagnostic instrumentation, not a load budget. It shows where time was
spent in one cycle but does not yet fail the build for excessive duration or
memory use at representative production symbol counts.

## H. API Guard

Dev APIs should be hard-guarded:

```ts
if (!isDevBacktestEnabled()) {
  res.status(404).json({ error: "Not found" });
  return;
}
```

Use `404` instead of `403` so production does not advertise that a dev endpoint exists.

The heavy backtest imports should also be moved inside the handler after the guard when practical:

```ts
const { runBacktestVolatilityDynamic } = await import("@/lib/dynamic/backtest-volatility");
```

This avoids loading heavy backtest modules in production unless the dev endpoint is intentionally enabled.

## I. Route Guard

Dev pages should also be unavailable in Railway production unless enabled.

Expected production behavior:

```text
ENABLE_DEV_BACKTEST unset:
  /dev/dynamic-trade -> not found
  /dev/coins -> not found
  /dev/vpoints -> not found
  /api/dev/dynamic-trade -> not found
  /api/dev/dynamic-trade/leaderboards -> not found
  /api/dev/coins -> not found
  /api/dev/coin-tags -> not found
  /api/dev/vpoints -> not found

ENABLE_DEV_BACKTEST=1:
  dev pages/APIs are available
```

## J. Real Memory Wins

These are already implemented or partly implemented and are more likely to
reduce actual Railway runtime memory:

- Runner and withdrawal flows load storage with `modeScope: "active"`, so the
  inactive mode is not hydrated into normal runtime memory.
- Closed production history is persisted in split per-symbol files and is not
  kept in `model_memory.positionsSell` during normal runner loads.
- Signal generation hydrates only the current UTC month's closed history when
  monthly counters need it, instead of loading all durable history.
- Runtime volatility is persisted outside the saved mode snapshot after cycle
  completion. The removed normalized-price cache is no longer loaded or
  generated.
- Latest 24-hour market volume is fetched as one ticker batch and persisted as a
  compact JSON snapshot.
- Live exchange-position reconciliation updates local open-position size/margin
  from `getPositions()` before averaging and exit logic, reducing accounting
  drift without additional per-position storage shapes.
- Dev/backtest routes and APIs are guarded so expensive local-only flows cannot
  be accidentally triggered in Railway production.
- Vitest setup masks Telegram credentials before application modules load, so
  quality and cycle tests cannot send real Telegram notifications from `.env`.
- Completed stage timing summaries are compactly persisted and visible in the
  dashboard, allowing runtime bottlenecks to be found without retaining raw
  profiler events.
- Runtime-only Node heap flags may be used as a tested safety guardrail, but
  they are not counted as an idle-memory reduction.

Still important operational habits:

- Keep symbol count reasonable for the live runner.
- Avoid calling dashboard/debug endpoints that return very large arrays unless
  the UI needs them.
- Monitor memory after deploys and after increasing symbol count.
- Compare memory only at equivalent points in the runner cycle; a cycle peak
  should not be compared with an idle post-GC floor.
- Disable the automatic runner only when manual execution is acceptable:

```bash
DISABLE_SLOW_TRADING_RUNNER=1
```

That flag can save memory and CPU, but it changes behavior because SLOW will no longer run automatically.

## K. Build Cleanliness Wins

These are good architecture, but may not visibly reduce idle memory:

- Removing dev routes from production access.
- Excluding persistent storage from standalone output tracing and deleting any
  copied standalone storage directory after the build.
- Avoiding imports of heavy backtest implementations from production dashboard
  modules.
- Keeping `/api/dev/*` separate from `/api/slow-trading/*`.
- Keeping backtest helpers out of shared production components unless they are type-only imports.
- Running `npm run build:railway` to remove unnecessary runtime files after the
  standalone build. Its cleanup script refuses to run without a completed
  standalone server and skips destructive cleanup outside Railway.
- Removing the unused standalone liquidation-map route, API, calculation model,
  charts, and page documentation while retaining exchange liquidation logic.

## L. Client-Only Dashboard Pages

Heavy dashboard pages should render as client-only UI:

```ts
const LiveDashboardPage = dynamic(() => import("./LiveDashboardPage"), {
  ssr: false,
  loading: () => <p>Loading SLOW dashboard...</p>,
});
```

Important App Router rule:

```text
Do not put dynamic(..., { ssr: false }) directly inside a Server Component page.
```

Next.js only supports `ssr: false` for Client Components. The route page can stay a Server Component for metadata and guards, but the `next/dynamic` call must live inside a `"use client"` wrapper component.

Current pattern:

```text
src/app/slow/page.tsx
  Server Component route shell and metadata
  imports "@/components/LiveDashboard"

src/components/LiveDashboard/index.tsx
  "use client"
  uses next/dynamic(..., { ssr: false })
  lazy-loads LiveDashboardPage
```

This reduces server-side rendering work for dashboard UI requests. It does not stop the SLOW runner, because the runner is server-side system logic and does not depend on whether the dashboard UI is open.

## M. Verification Checklist

After optimization changes:

```bash
npm run type
npm run build
```

For normal code changes, also run:

```bash
npm run quality
```

Then verify the build route list:

```text
/slow exists
/api/slow-trading/* exists
/dev/dynamic-trade is unavailable or guarded in production
/dev/coins is unavailable or guarded in production
/dev/vpoints is unavailable or guarded in production
/api/dev/dynamic-trade is unavailable or guarded in production
/api/dev/dynamic-trade/leaderboards is unavailable or guarded in production
/api/dev/coins is unavailable or guarded in production
/api/dev/coin-tags is unavailable or guarded in production
/api/dev/vpoints is unavailable or guarded in production
/liquidation does not exist
/api/liquidation-map does not exist
```

On Railway, watch:

- Memory should settle after startup instead of establishing a new higher floor
  after every equivalent cycle.
- CPU should stay low between runner cycles.
- No repeated SIGTERM/restart loop.
- `/slow` loads normally.
- Storage still persists under `/storage`.

Local memory comparison flow:

```bash
npm run build
npm run start:local
npm run monitor:local
```

Repeat with representative symbol counts such as 9, 15, and 50 coins. Record
idle memory after startup and memory after at least one runner cycle.

For the current Railway observation, capture at least `60-120 minutes` after a
fresh restart and include several occurrences of every enabled scheduled stage.
Record these checkpoints:

1. The first idle reading after the server becomes healthy.
2. Memory immediately before and after each SLOW runner cycle.
3. Memory before and after the first `/slow` dashboard visit.
4. The lowest memory reading between cycles, not only each peak.
5. Any deployment, restart, dashboard backtest, withdrawal scan, or account
   configuration change on the same timeline.

To attribute the warm floor instead of only observing it, each checkpoint must
record the process id/deployment id plus all fields already available from
`resource-monitor.ts`: cgroup used, process RSS, V8 heap used/committed,
external memory, and ArrayBuffers. Also record public-market cache occupancy and
the stage name. Process-specific samples must exclude the old/new deployment
overlap window.

Escalate to a heap/RSS investigation when the between-cycle floor continues to
rise over multiple comparable cycles, memory does not plateau during the full
observation window, or Railway restarts the service for memory pressure. A
single startup staircase that settles is normal warm-up evidence and should not
be treated as a confirmed leak.

## N. Remaining Optimization Risks

- Cycle-section timing instrumentation and its quality test exist, but there is
  no automated memory regression or realistic multi-symbol load budget for a
  full production SLOW cycle.
- There is no bundle-size budget or bundle analyzer report checked into the
  normal quality workflow.
- The dashboard still has limited rendering tests, so UI changes may
  accidentally increase client bundle size without an obvious test failure.
- Exchange integration tests are limited, especially for Binance futures, which
  is important for production-like position reconciliation.
- Some production coin metadata UI still imports components from the dev
  directory. This is naming and ownership debt that can obscure future bundle
  regressions.
- Three guarded dev page route modules still statically import their page UI.
  This does not put those chunks into `/slow`, but a bundle analysis should
  decide whether moving them behind post-guard dynamic imports is worthwhile.
- Keep generated cache and history files compact; audit any new `fs.writeJSON`
  use before it enters a hot persistence path.

## O. Decision

Excluding dev/backtest from production is the right architecture.

Expected impact:

```text
Production safety: high
Bundle cleanliness: medium/high
Idle memory reduction: low/medium
Runtime spike reduction: medium/high if dev APIs cannot be called
```

Current status:

```text
Production safety: good
Runtime memory posture: warm resident delta confirmed; unbounded leak unproven
Memory attribution: transient SLOW-cycle allocation is the leading cause;
  heap/native/cache split still needs process-specific samples
Measurement discipline: needs improvement
Optimization confidence score: 82/100
```

The next meaningful improvement is to instrument memory around every stage,
then remove full-dataset hydration and duplicate clones from the hottest stage.
If the allocator still keeps the high floor, isolate that work in a short-lived
child process. Bundle analysis and a deterministic production-cycle load test
should then enforce explicit duration, peak-memory, and post-stage baseline
budgets.
