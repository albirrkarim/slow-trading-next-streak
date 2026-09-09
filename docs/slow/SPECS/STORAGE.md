# Storage

This document defines the required SLOW storage behavior.

## C.1 Single Storage Truth

TC : `PROD:STORAGE_SOURCE_OF_TRUTH`

Everything in the UI of Slow Trading must be loaded from files under:

`storage/persistent/instances/[PORT]/slow`

This folder is the source-of-truth root for slow trading. The data may be split into multiple files such as config, memory, history, and volatility cache.

## C.2 History Independence

Closed trade history is loaded from every persisted symbol file for the
requested mode. It must not be filtered by the current strategy symbol config.
Removing a symbol from `config.symbols` hides it from future scanning and entry,
but its existing history remains visible in the navbar report, daily PnL, and
dashboard statistics.

Lean runtime loads without history must not add those historical-only symbols
back into runtime trade settings.

TC: `PROD:HISTORY_CONFIG_INDEPENDENT`

## C.3 Trade History Notes

Closed positions may contain an optional user-authored `notes` string. Editing
a note in the trade-history report persists `position.notes` directly in that
symbol's compact mode history JSON file. The save must update only the matching
position file. Leading and trailing whitespace is removed, and an empty note
removes the optional property.

TC: `PROD:TRADE_HISTORY_NOTES`

### C.3.1 Monthly Trade Sharpe

Each month in the Daily PnL Calendar shows an unannualized Trade Sharpe derived
only from closed trade history. The month is the time window and each observed
UTC calendar day is one return observation. A day's return is the sum of
fee-aware `position.pnl.netPct` values for trades closed that day; observed days
without a closed trade contribute `0%`.

The risk-free rate is `0%`. Trade Sharpe is the mean daily trade return divided
by its population standard deviation. The calendar displays `N/A` when fewer
than two daily observations exist or when their standard deviation is zero.
Balance snapshots, deposits, withdrawals, Safe Haven transfers, and other cash
flows must not affect this metric. Production history and Quick Backtest use
the same shared calculation. The calendar colors a valid Trade Sharpe below
`1` red, from `1` to below `2` orange, and `2` or above green. `N/A` remains
neutral.

TC: `BOTH:MONTHLY_TRADE_SHARPE`

### C.3.2 Multi-account Daily Balance Snapshots

Each account writes its own live and sandbox UTC-day balance snapshot. The
Daily PnL Calendar aggregates snapshots, starting balances, and closed-trade
history for enabled accounts only. For an account without a snapshot on an
observed day, the calendar carries forward that account's latest earlier
balance; it does not include an account before that account's first snapshot.

The pre-launch multi-account format is a hard cutover. The former mode-wide
snapshot file is not read, assigned to an account, or combined with
account-scoped data.

TC: `PROD:MULTI_ACCOUNT_DAILY_BALANCE_SNAPSHOTS`

## C.4 Live Exchange Account Storage

SLOW stores Binance account profiles in `accounts.json`, separate from shared
strategy `config.json`. Each account has an immutable unique `slug`, dashboard
label, credentials, enabled state, Trading-tab configuration (including the
`entryLegs` Hedge selection), Sandbox controls,
and declared futures position mode. `runtime.exchangeAccountSlug` selects the
profile edited by account-scoped settings and API actions; it does not limit
which enabled accounts execute.

Live and sandbox execution memory is isolated under each account slug in
`memory.json`. Closed history remains shared, and every open, closed, sandbox,
live, and backtest position carries its owning account slug. Deleted slugs are
retired permanently. There is no ID-profile or single-account-memory migration:
this pre-launch project uses the slug-based format as a hard cutover.

A Binance account may also persist `futuresPositionMode` as `ONE_WAY` or
`HEDGE`. The account manager exposes this value, and storage normalization
preserves only those two recognized literals. Both-direction runtime entry
requires `HEDGE`; the saved value is a declared prerequisite and does not
replace live verification against Binance.

Enabled accounts execute sequentially with shared public market preparation.
Disabling an account blocks new entries but keeps its existing positions under
monitoring, protection, averaging, and exit management. Disabled accounts are
excluded from combined dashboard and MCP output.

Loading accounts is read-only when `accounts.json` already exists. Explicit
account, config, and memory saves stage complete JSON in a unique temporary file
and atomically replace the destination, so concurrent readers never observe a
truncated payload.

Before a live futures entry, the system must successfully configure the
exchange leverage and isolated margin mode. A rejected exchange configuration
must abort the cycle so the production error boundary records it in
`errors.json` and sends the configured SLOW error notification.

Sandbox futures entries use the same leverage calculation but must not call
private exchange account-configuration endpoints.

Each account's `trading.notes` is a user-authored strategy reminder stored in
`accounts.json`. It is account metadata: it must survive account normalization,
backup and restore, and Trading-editor account switches, but it must not be
projected into the effective execution configuration or affect calculations.

TC: `PROD:FUTURES_ENTRY_ACCOUNT_SETUP`

TC: `PROD:ATOMIC_PERSISTENT_JSON`

TC: `PROD:MULTI_ACCOUNT_TRADING_NOTES`

## C.5 Backtest Storage

The dynamic backtest reads compact volatility events from
`storage/datasets/UI_TEMP/VOLATILITY/[exchange]/[range]`. Missing files are
created there from in-memory klines. Backtests do not create or depend on the
legacy `UI_TEMP/KLINES` and `UI_TEMP/COMMON_TIME` datasets.

TC: `BTEST:BACKTEST_VOLATILITY_DATASET`

## C.6 Backtest Market Selection

The dynamic backtest must use volatility data from the market selected by its
trading mode. Futures backtests use Futures volatility points and Spot
backtests use Spot volatility points. If a compatible volatility cache is
missing, its source klines are fetched from only the selected market.

TC: `BTEST:BACKTEST_MARKET_TYPE`

## C.7 Canonical Position Storage

Production, sandbox, history, and dynamic backtest storage use the same nested
`Position` contract defined in `docs/slow/OPTIMIZATION/DATA_TYPE.md`.
Runtime code does not read the former flat position keys.

The canonical contract supports `position.role` with `MAIN` and `COUNTER`
values. Missing legacy roles resolve to `MAIN`. Paired legs can share symbol,
entry vPoint id, and entry time, so durable history identity and history API
mutations additionally use role and direction to distinguish them.

New BOTH workers also persist `position.pairId`. The id remains stable while
MAIN and COUNTER independently close and re-enter from newer vPoint anchors.
Legacy pairs without it continue to resolve from their shared original symbol,
entry vPoint id, and entry time.

New positions also persist the compact optional `opened.vPoint.t` anchor time.
Target resolution prefers this vPoint time over the later order-execution time,
while legacy records without it continue to use `opened.t`.

When one BOTH leg closes while its counterpart remains open, its full position
is written only to closed history. Mode memory persists a compact
`pendingReentries` item containing `pairId`, `role`, `direction`, the original
`opened.t`/`opened.vPoint` anchor, and `closeReason`. This is durable re-entry
state, not an open position. A successful replacement clears the item; closure
of the remaining leg clears the pair's pending state. On load, legacy memory
that retained a closed leg beside an active counterpart is migrated into this
shape and the closed leg is detached from `positions`.

The hard-cutover migration is exposed at `/api/alter/position`:

- `GET /api/alter/position?dryRun=true` scans and validates without writing.
- `POST /api/alter/position` migrates every validated changed file as compact
  JSON.
- The position migration only selects mode memory, legacy state, symbol history,
  and dynamic-backtest files. It must never select SLOW `config.json`,
  `accounts.json`, or other operational configuration files.
- Changed files are replaced atomically and retain a timestamped
  `.position-alter.<id>.bak` recovery copy.
- All changed files are prepared and validated before replacement begins.
- A failed replacement restores the staged backups.
- Re-running the endpoint after migration is idempotent.

TC: `PROD:CANONICAL_POSITION_STORAGE`

## C.8 Persistent Storage Clone

The debugging storage clone copies the source server's persistent-storage
directory as raw file bytes. It validates only the transfer bundle and relative
paths, creates a timestamped backup of the destination, stages the incoming
files, and replaces the destination directory.

The clone endpoint must not load, normalize, migrate, or rebuild dashboard state
from the copied files. Schema migration is a separate explicit operation.

TC: `PROD:SYNC_ONLINE_TO_LOCAL`

## C.9 Compact Position vPoint Path

Closed production, sandbox, and backtest positions persist the ordered
intermediate volatility-point path as `position.vPoints`. Each item reuses
`PositionVPointRef` and contains only `id` and `lvl`.

The array excludes the entry point already stored in `opened.vPoint` and the
exit point stored in `closed.vPoint`. An empty array means the path was captured
successfully but no intermediate vPoint occurred. An omitted field means the
path belongs to legacy data or could not be recovered.

`/api/alter/position` backfills recoverable closed histories from persisted
volatility sources while retaining its dry-run, compact JSON, backup, atomic
replacement, rollback, and idempotency guarantees.

TC: `BOTH:POSITION_VPOINT_PATH`

## C.10 Open-Position Funding Snapshot

Futures monitoring persists only the latest valid public funding snapshot as
the optional top-level `position.funding` object. It stores `exchange`, raw
decimal `rate`, exchange timestamp `t`, and optional next settlement timestamp
`nextT`. It does not duplicate the symbol or persist display-only payer,
crowded-side, formatted-percent, or human-readable time labels.

The snapshot is shared by live and sandbox monitoring and is retained when the
position moves into closed history. Legacy and spot positions may omit it.

TC: `PROD:MONITORING_POSITION_FUNDING_RATE`

## C.11 Incremental Volatility Persistence

Production volatility assignment remains sequential. After one symbol's
prediction-engine refresh succeeds, its volatility memory is merged by point
id and atomically persisted before assignment advances to the next symbol.

If a later symbol fails, every earlier successful symbol remains available on
the next cycle and is not discarded with the failed cycle. Concurrent callers
for the same exchange, market, symbol, and actionable-level configuration join
one in-progress calculation. This is part of the existing assignment loop and
does not introduce a separate bootstrap queue or storage format.

Account balances, positions, decisions, orders, and mode memory remain outside
the shared volatility calculation.

TC: `PROD:VOLATILITY_INCREMENTAL_PERSISTENCE`
