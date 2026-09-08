# SLOW Production Optimization

This document tracks how to keep the SLOW Railway deployment clean, efficient, and production-focused.

## Optimization Score: 82/100

Assessment date: September 8, 2026.

The current SLOW production shape is reasonably optimized for a small Railway
deployment. Dev/backtest routes are guarded, the `/slow` dashboard is client
lazy-loaded, runtime storage loads only the active mode, closed trade history is
split out of normal memory, and several runtime caches are persisted outside the
hot storage object. Completed SLOW stages also persist a compact section-duration
breakdown, making the slowest operation visible from the dashboard. The remaining
optimization gap is mostly bounded measurement: there is no regular memory
budget report, no bundle-size budget, and no production-like load test that
proves the memory cap is safe across larger symbol or account counts. A short
Railway sample now shows post-restart warm-up followed by partial reclamation
and an early plateau, but it still needs a long-duration stability check.

The score increased from 78 because cycle timing is now observable and tested,
the full standalone liquidation-map feature was removed, and every current dev
page/API has an explicit production guard. The score reflects architecture and
operational safety, not a measured percentage reduction: peak memory, client
bundle size, and production-scale throughput have not yet been benchmarked.

### Assessment evidence

This assessment is based on the repository state and verification available on
September 8, 2026:

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
- `npm run quality` passed with 126 test files and 725 tests.

No heap profile, route-chunk report, or long-duration Railway load sample has
been captured. Those missing measurements cap the score.

### Railway restart observation — September 8, 2026

A Railway observability screenshot for the production `Streak Grail : Two
snake` service shows this approximate sequence:

- Before the restart, memory was roughly `195-205 MB` during the visible
  11:09-11:15 interval.
- At approximately 11:15, the container restart reduced memory to roughly
  `105 MB`.
- From approximately 11:16 through 11:23, memory increased in steps to roughly
  `135-140 MB`.
- From approximately 11:23 through 11:26, memory declined to roughly
  `120-125 MB`, then remained nearly flat through 11:29.
- CPU remained close to idle except for a short spike around the restart/cycle
  boundary.

The newer sample shows that at least part of the startup increase was reclaimed
and does not show continuous growth through the end of the visible window. That
supports a warm-up/plateau interpretation more than a leak interpretation.
However, the roughly 14-minute post-restart window is still too short to prove
long-term stability. Next.js module loading, V8 heap expansion, exchange
initialization, dashboard requests, and the first SLOW cycles can all establish
a higher warm baseline. V8 may retain committed heap after garbage collection
instead of immediately returning it to the operating system.

The important distinction is:

```text
Warm-up: memory rises after restart, then oscillates around a stable plateau.
Leak/retention: the post-GC floor keeps rising across equivalent runner cycles.
```

Treat the current runtime memory posture as **early plateau observed; long-term
stability still under observation**. Do not lower the configured V8 limits
until a longer sample confirms the plateau across repeated scheduled stages.

The main rule:

```text
Production should only ship and run the SLOW dashboard, SLOW APIs, auth, storage, exchange execution, and notification logic.
Development backtest pages/APIs should not be available or loaded in Railway production unless explicitly enabled.
```

## Goals

- Keep Railway memory stable and low.
- Keep the standalone production bundle focused on `/slow`.
- Avoid accidental production access to heavy dev/backtest tools.
- Keep dev/backtest tools available locally.
- Make optimization decisions based on real runtime impact, not only build output cosmetics.

## Current Production Target

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
NODE_OPTIONS=--max-old-space-size=128 --max-semi-space-size=4
```

This is a conservative production cap. If memory is still stable after normal
runner cycles, dashboard use, and withdrawal scans, a tighter cap can be tested:

```bash
NODE_OPTIONS=--max-old-space-size=96 --max-semi-space-size=2
```

Use the tighter cap only after observing that the app does not restart during
normal runner cycles. `--max-old-space-size` limits V8 old-space, not the
process's total Railway memory. Total RSS also includes young-generation heap,
native allocations, buffers, loaded code, and runtime overhead, so Railway can
report more than the configured old-space value.

## Dev/Backtest Exclusion

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

## Implemented Controls

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

## Production UI Boundaries

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

## Runtime Performance Visibility

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

## API Guard

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

## Route Guard

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

## Real Memory Wins

These are already implemented or partly implemented and are more likely to
reduce actual Railway runtime memory:

- Runner and withdrawal flows load storage with `modeScope: "active"`, so the
  inactive mode is not hydrated into normal runtime memory.
- Closed production history is persisted in split per-symbol files and is not
  kept in `model_memory.positionsSell` during normal runner loads.
- Signal generation hydrates only the current UTC month's closed history when
  monthly counters need it, instead of loading all durable history.
- Runtime caches such as volatility and `priceNormMapOverTime` are persisted to
  cache files and removed from the saved mode snapshot after cycle completion.
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
- `NODE_OPTIONS` old-space and semi-space caps are available for controlling
  worst-case memory growth.

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

## Build Cleanliness Wins

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

## Client-Only Dashboard Pages

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

## Verification Checklist

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

Escalate to a heap/RSS investigation when the between-cycle floor continues to
rise over multiple comparable cycles, memory does not plateau during the full
observation window, or Railway restarts the service for memory pressure. A
single startup staircase that settles is normal warm-up evidence and should not
be treated as a confirmed leak.

## Remaining Optimization Risks

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

## Decision

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
Runtime memory posture: early post-restart plateau; long-term stability unproven
Measurement discipline: needs improvement
Optimization confidence score: 82/100
```

The next meaningful improvement is to turn the existing section timing into
repeatable budgets: bundle analysis, memory samples under realistic symbol
counts, and a deterministic production-cycle load test with explicit duration
and memory thresholds.
