# Oura sleep tracking design

**Date:** 2026-05-18
**Status:** Approved, pending implementation

## Goal

Add Oura Ring sleep tracking to vitals: a new adapter that syncs sleep sessions, storage that holds them faithfully, and an MCP surface that downstream report-style consumers can query. Vitals owns sync, storage, and query; the opinionated weekly reporting lives outside this repo.

The primary V1 query is: "for each of the past 7 nights, was the longest continuous asleep block ≥ 7 hours?" Vitals must answer that with one MCP call.

## Context

Vitals is a one-adapter codebase (Fitbit, via Google Health API) that wants to be a many-adapter codebase. Schema, MCP surface, notifications, and query layer are deliberately adapter-generic; vendor names live only inside `src/adapters/<vendor>/`. Adding Oura is the second adapter and the first non-OAuth one.

Three constraints shape the decisions below:

1. **Standards where possible.** Per-session aggregates (TST, WASO, etc.) use LOINC. Per-epoch stage classifications use AASM vocabulary at the query layer. The one vitals-controlled URI exists because AASM doesn't publish a terminology service — the vocabulary itself is AASM, not vitals.

2. **Adapter-faithful storage.** Each adapter stores observations in its native vocabulary. Translation to canonical taxonomies (AASM) happens in the query layer, not at write time. This avoids contaminating standard taxonomies with vendor-specific ambiguity (Oura's "light" stage is `{N1, N2}` unresolved — that ambiguity belongs in a per-adapter mapping, not in `AASM_SLEEP_STAGE`).

3. **Generic MCP tools.** The primary V1 query is "longest continuous period in value range" — a generic clinical-data primitive (longest continuous asleep block, longest tachycardic run, longest SpO2 dip, etc.). One new generic MCP tool serves sleep today and any future range-and-contiguity query without extension.

## Architecture summary

- **Adapter:** `src/adapters/oura/` with personal-access-token auth. Pulls `/usercollection/sleep` for a window of recent days, one source document per session, skip-if-ingested by Oura session id.
- **Storage:** Per-session LOINC aggregate observations + per-stage-run observations in Oura's native vocabulary. Stage runs are run-length encoded from Oura's `sleep_phase_5_min` epoch string.
- **Taxonomy:** `AASM_SLEEP_STAGE` is the canonical taxonomy (five real AASM stages). `OURA_SLEEP_STAGE` is the native vocabulary. A per-adapter mapping (`OURA_TO_AASM`) declares each native code as a _set_ of possible AASM stages, expressing ambiguity explicitly.
- **MCP:** New tool `get_longest_continuous_period_in_value_range` (sibling to existing `get_period_duration_in_value_range`). Both tools recognize the AASM canonical coding URI and translate to per-adapter native queries under a conservative-inclusion rule.
- **Confidence/freshness:** Generalized from Fitbit-specific to per-coding routing via a `ConfidenceProvider` registry. Oura's sleep confidence is time-based (provisional if `end_local_date` within 24h, else confirmed).
- **Notifications:** One new condition `oura-auth-invalid`. Everything else reuses the generic sync-failure machinery.

## Decisions

### Storage

#### Source documents

One row per Oura sleep session. Archive key uses Oura's stable session id:

```
archive_key = `oura/sleep/${session_id}.json.gz`
```

Multiple sessions per day (main + naps) each get their own archive key. No date-based collision. The raw Oura JSON is stored gzipped in the blob store; the row's `metadata_json` carries the per-session attributes that downstream code consumes without re-parsing the blob:

```ts
metadata_json: {
  document_type: 'unknown',
  document_date: end_local_date,           // YYYY-MM-DD, local TZ of session end
  document_date_range: null,
  contributors_to: ['observations'],
  // Oura-session-specific
  bedtime_start: ISO string with offset,
  bedtime_end: ISO string with offset,
  end_local_date: 'YYYY-MM-DD',
  start_tz_offset_minutes: integer,
  category: 'main' | 'nap' | 'rest' | 'other',
}
```

`category` is mapped at the adapter boundary from Oura's `type` field (`long_sleep` → `main`, `late_nap` → `nap`, `rest` → `rest`, others → `other`). `end_local_date` is derived from `bedtime_end + offset` and is the consumer-facing anchor for "the night ending on this date."

#### Per-session LOINC aggregate observations

Each session produces one observation row per AASM-standard metric. All share the same `effective_start = bedtime_start`, `effective_end = bedtime_end`, and `source_document_id`:

| Metric                        | LOINC code            | Unit  |
| ----------------------------- | --------------------- | ----- |
| Total sleep time (TST)        | 93832-4               | `min` |
| REM sleep duration            | 93829-0               | `min` |
| Light sleep duration          | 93830-8               | `min` |
| Deep sleep duration           | 93831-6               | `min` |
| Wake after sleep onset (WASO) | 103215-0              | `min` |
| Sleep efficiency              | _verify code at impl_ | `%`   |
| Sleep onset latency (SOL)     | _verify code at impl_ | `min` |

Values come directly from Oura's pre-calculated fields (`total_sleep_duration`, `rem_sleep_duration`, etc.). We trust Oura's numbers rather than re-deriving from the stage timeline, because Oura has access to internal signal data we don't.

#### Per-stage-run native observations

Each contiguous same-stage run within a session becomes one observation row:

- `coding.system`: `https://vitals.fhwang.net/coding/oura/sleep-stage`
- `coding.code`: `oura-sleep-stage`
- `value_quantity`: numeric, per `OURA_SLEEP_STAGE` enum
- `value_unit`: `{stage}` (UCUM annotation for unitless ordinal observations)
- `effective_start`, `effective_end`: run boundaries (5-minute epoch-aligned)

```ts
// src/adapters/oura/sleep-stage.ts
export const OURA_SLEEP_STAGE = {
  deep: 1,
  light: 2,
  rem: 3,
  awake: 4,
} as const;
```

Run-length encoding: walk Oura's `sleep_phase_5_min` string; collapse consecutive same-stage characters into a single run with a 5-minute-multiple duration. A typical 8-hour session yields ~30–80 rows. Awake runs are stored (not skipped) so every epoch is covered and within-session adjacency is exact (`obs[N].effective_end === obs[N+1].effective_start`).

#### Epoch-size invariant

Before parsing, verify: `sleep_phase_5_min.length × 300 ≈ (bedtime_end − bedtime_start)` (in seconds, within a small tolerance). If broken, throw `SyncError('parse_error', …)` with the actual ratio in the message. This is a load-bearing assertion — if Oura ever changes the format, we want to fail loudly rather than silently produce miscalibrated rows.

### Taxonomy: AASM as canonical, native as faithful

#### `AASM_SLEEP_STAGE` — canonical, exposed to the query layer

```ts
// src/records/aasm.ts
export const AASM_SLEEP_STAGE = {
  wake: 0, // W
  n1: 1, // NREM 1 — transitional light
  n2: 2, // NREM 2 — stable light
  n3: 3, // NREM 3 — deep / slow-wave
  rem: 4, // REM
} as const;
```

Five stages. No ambiguity slot, no compound stages. The vocabulary follows the [AASM Manual for the Scoring of Sleep](https://aasm.org/clinical-resources/scoring-manual/).

**Stable contract for queries:** `0 = wake; any positive integer = some flavor of asleep.` New stages added later are positive integers and never break existing "any asleep" range queries.

#### `OURA_SLEEP_STAGE` — native, adapter-internal

Oura's own four-state vocabulary, encoded numerically. Lives inside the Oura adapter and never appears in shared schemas or canonical surfaces.

#### `OURA_TO_AASM` — per-adapter mapping with explicit ambiguity

```ts
// src/adapters/oura/sleep-stage-mapping.ts
export const OURA_TO_AASM: ReadonlyMap<number, ReadonlySet<number>> = new Map([
  [OURA_SLEEP_STAGE.deep, new Set([AASM_SLEEP_STAGE.n3])],
  [OURA_SLEEP_STAGE.light, new Set([AASM_SLEEP_STAGE.n1, AASM_SLEEP_STAGE.n2])],
  [OURA_SLEEP_STAGE.rem, new Set([AASM_SLEEP_STAGE.rem])],
  [OURA_SLEEP_STAGE.awake, new Set([AASM_SLEEP_STAGE.wake])],
]);
```

Oura's "light" maps to the _set_ `{N1, N2}` because Oura has no EEG and physically cannot distinguish those substages. The ambiguity is honest data, not a labeling quirk.

#### Coding URIs

| Purpose                 | URI                                                 | Notes                                                                                        |
| ----------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Canonical AASM taxonomy | `https://vitals.fhwang.net/coding/aasm/sleep-stage` | Vitals hosts the URI because AASM doesn't run a terminology service; the vocabulary IS AASM. |
| Oura native stages      | `https://vitals.fhwang.net/coding/oura/sleep-stage` | Adapter-internal; appears in stored observation rows.                                        |

The vitals-hosted URIs are documented in code with comments explaining that AASM/Oura are the source of truth for the vocabulary and that vitals is the addressable home only because the upstream doesn't publish one.

#### Conservative-inclusion translation rule

When a query specifies a canonical-coding value range corresponding to AASM stage set `R`, a native code `c` matches if and only if `OURA_TO_AASM(c) ⊆ R`.

| Requested AASM                   | Oura "deep" `{N3}` | Oura "light" `{N1,N2}`              | Oura "REM" `{REM}` |
| -------------------------------- | ------------------ | ----------------------------------- | ------------------ |
| `{N1}`                           | no                 | no (ambiguous, would falsely claim) | no                 |
| `{N1, N2}`                       | no                 | **yes**                             | no                 |
| `{N3}`                           | **yes**            | no                                  | no                 |
| `{N1, N2, N3, REM}` (any asleep) | **yes**            | **yes**                             | **yes**            |

A native code matches only when every AASM stage it could represent falls inside the requested set. This is the honest answer to "could this epoch satisfy the AASM query?" — never falsely specific, always correct on coarser queries.

### MCP surface

#### New tool: `get_longest_continuous_period_in_value_range`

Sibling to existing `get_period_duration_in_value_range`. Same input shape, different aggregation: `max` of contiguous-run minutes instead of `sum` of total minutes.

```ts
get_longest_continuous_period_in_value_range({
  coding: { system: string, code: string },
  date_range: { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' },
  value_range: { min: number, max: number },
  bucket: 'none' | 'day',
  gap_seconds?: number,   // default 0; strict adjacency
})
→ {
  // when bucket = 'none'
  longest_minutes: number,
  longest_start: ISO string | null,
  longest_end: ISO string | null,
  // when bucket = 'day'
  per_bucket: Array<{
    bucket_start: 'YYYY-MM-DD',
    longest_minutes: number,
    longest_start: ISO string | null,
    longest_end: ISO string | null,
  }>,
  // always
  confidence_by_date: Array<{ date: 'YYYY-MM-DD', confidence: 'confirmed' | 'provisional' }>,
  freshness_frontier_at: ISO string | null,
}
```

**Bucket semantics for `'day'`:** a run is attributed to the calendar date on which its `effective_end` falls, in local TZ. For sleep this matches "the night belongs to the morning"; for cross-midnight HR runs it picks the end date.

**Contiguity rule:** two observations are part of the same run if (a) both match the value predicate, and (b) `obs[N+1].effective_start − obs[N].effective_end ≤ gap_seconds`. Default `gap_seconds = 0` enforces strict adjacency, which is correct for run-length-encoded stage data. HR-style queries (where samples may have small polling gaps) can relax via `gap_seconds: 60` or similar.

#### AASM canonical coding handling

Both this new tool and the existing `get_period_duration_in_value_range` recognize the canonical AASM coding URI and translate internally:

1. Parse the query: if `coding.system === AASM_SLEEP_STAGE_URI`, treat as canonical.
2. Convert `value_range` to the AASM stage set `R = {n : min ≤ n ≤ max}`.
3. Look up the **taxonomy registry** for adapters that map to AASM sleep-stage. For each adapter, ask its mapping for the set of native codes `C = {c : adapter_mapping(c) ⊆ R}`.
4. Run the query against each adapter's native observations with native coding and `value_range` over `C`. Aggregate results.
5. For V1 only Oura contributes; the multi-adapter aggregation path is designed (see below) but not exercised.

The V1 query becomes:

```
get_longest_continuous_period_in_value_range({
  coding: {
    system: 'https://vitals.fhwang.net/coding/aasm/sleep-stage',
    code:   'aasm-sleep-stage',
  },
  date_range:  { start: '2026-05-11', end: '2026-05-17' },
  value_range: { min: 1, max: 4 },    // N1..REM = any asleep
  bucket: 'day',
})
```

Per-night longest asleep block, with confidence and freshness annotations.

### Sync mechanics

#### Auth

Personal access token (PAT) generated by the user at the Oura cloud dashboard, stored as a row in `adapter_credentials` with `adapter_name = 'oura'`. The `credentials_json` carries `{ access_token: string }`; no refresh logic. A CLI/setup flow writes the initial credential row.

#### Parameter schema

Mirrors Fitbit's shape:

```ts
export const OuraParameterSchema = z.object({
  window_days: z.number().int().min(1).max(31).default(8),
});
```

#### Sync flow

Each tick calls `/usercollection/sleep?start_date=…&end_date=…` for the last `window_days`. One API call returns every session ending in the window with full details inline (stage timeline, aggregates, the lot).

For each returned session:

```
if alreadyIngested(session.id):  // archive_key lookup
  continue
parse session, verify epoch invariant
write source_document + observations in one transaction
```

After ingesting all new sessions:

```
writeStateSuccess('oura', now)
updateFrontierAfterTick('oura', max(bedtime_end across new sessions))
```

#### Force-refresh policy

V1 policy: **skip-if-ingested by session id; no force-refresh window.** Oura sessions are atomic — once a session appears in the API, its data is essentially immutable. Late-arriving data manifests as session _absence_, not session _partiality_.

If we observe stale-after-ingestion behavior in practice (e.g., user manually edits sleep times, Oura algorithm refines a classification), add `FORCE_REFRESH_DAYS = 3` and drop-replace by session id. Out of V1 scope.

#### No per-day state

Sleep doesn't have a samples-stability signal the way HR does. A date might have 1, 2, or 0 sessions, and the "expected" count varies by user behavior. We do not write `adapter_day_state` rows for Oura; the day-state table's `samples_count` field is meaningless for atomic sessions.

#### Session category encoding

Oura's `type` field maps at the adapter boundary:

| Oura `type`   | Vitals `category` |
| ------------- | ----------------- |
| `long_sleep`  | `main`            |
| `sleep`       | `main`            |
| `late_nap`    | `nap`             |
| `rest`        | `rest`            |
| anything else | `other`           |

Category lives only in `source_documents.metadata_json`. It's not exposed through observations or codings. The V1 query doesn't filter by category — it asks for "longest asleep block" and naps fall out naturally because nap sessions are separated from main sessions by hours of `value=awake` (or no observations at all between sessions), which the contiguity rule breaks on.

### Confidence model

#### Sleep confidence rule

```
provisional if end_local_date is within 24h of now
confirmed   otherwise
```

Pure time-based. Why pure time beats "session-presence":

- A session-presence rule would mark "user took the ring off all night" dates as permanently provisional, since no session would ever arrive. Callers would see `provisional` for legitimate no-data nights.
- The pure-time rule treats every date as settled after 24h, regardless of data presence. Callers see `longest_minutes: 0` on a `confirmed` date and read that as "no sleep was recorded" — correct.

#### Implementation

```ts
// src/adapters/oura/confidence.ts
export function buildOuraSleepConfidenceByDate(
  now: Date,
  dateRange: [string, string],
): ConfidenceByDate[];
```

Pure function of `(now, dateRange)`. No DB read needed.

#### `freshness_frontier_at` for sleep

Same field on `adapter_state` as Fitbit uses, populated by `updateFrontierAfterTick` from the sync flow. Value is the latest `bedtime_end` across ingested Oura sessions. The query layer picks the right adapter's row based on the query's coding (see next section).

### Per-adapter freshness/confidence generalization

#### Today's hardcoded path

```ts
// src/query/sqlite-archive.ts
const meta: PeriodDurationMeta = {
  confidence_by_date: buildConfidenceByDate(db, new Date(), [...]),  // Fitbit-only
  freshness_frontier_at: getFitbitFreshnessFrontier(db),             // Fitbit-only
};
```

Both functions live in `src/adapters/fitbit/confidence.ts` and are re-exported from `#adapters` under Fitbit-specific names but with adapter-agnostic API surface today. Comment in `sqlite-archive.ts` already flags this as "accurate for Fitbit-sourced data, conservative for others."

#### `ConfidenceProvider` interface

```ts
// src/adapters/index.ts (or src/adapters/confidence.ts)
export interface ConfidenceProvider {
  buildConfidenceByDate(now: Date, dateRange: [string, string]): ConfidenceByDate[];
  getFreshnessFrontier(): string | null;
}
```

Each adapter exposes one.

#### Registry-based routing

`AdapterRegistry` gains:

```ts
interface AdapterRegistry {
  // existing
  list(): readonly Adapter[];
  byName(name: string): Adapter | undefined;
  // new
  getConfidenceProvider(coding: Coding): ConfidenceProvider | null;
}
```

`getConfidenceProvider` resolves a coding to the contributing adapter(s) via the same taxonomy/coding-system lookup the AASM translation uses. Returns a single adapter's provider (V1) or a composite (future).

Query layer refactor:

```ts
const provider = adapters.getConfidenceProvider(query.coding);
const meta: PeriodDurationMeta = {
  confidence_by_date: provider?.buildConfidenceByDate(new Date(), dateRange) ?? [],
  freshness_frontier_at: provider?.getFreshnessFrontier() ?? null,
};
```

#### Composite aggregation rules (designed, not implemented in V1)

For codings produced by multiple adapters:

- **Confidence per date:** most-conservative wins. Any contributor returning `provisional` for a date makes the date `provisional`.
- **Freshness frontier:** minimum across contributors. Returns `null` if any contributor returns `null`.

V1 has exactly one contributor per coding. The composite path is interface-only.

#### File reorganization

- `src/adapters/fitbit/confidence.ts` — Fitbit's `ConfidenceProvider` implementation (`getFitbitDayConfidence` already lives here; refactor exports).
- `src/adapters/oura/confidence.ts` — Oura's `ConfidenceProvider` implementation (the time-based rule).
- `src/adapters/index.ts` — exports `ConfidenceProvider`, `ConfidenceByDate`, `DayConfidence`. Registry routing.
- `ConfidenceByDate` and `DayConfidence` types move out of the Fitbit-specific file into a shared location.

### Failure modes / notifications

#### New condition: `oura-auth-invalid`

Fires when the Oura API returns 401 or 403 on a sync attempt. Same shape as the existing `fitbit-auth-expired` condition (adapter prefix encodes the failure-mode identity, not vendor leakage).

User action: regenerate PAT at the Oura cloud dashboard; update vitals' credentials. Resolution: next successful sync writes `last_sync_status: 'success'`, condition evaluates as resolved.

#### Detection in the adapter

```ts
// src/adapters/oura/api.ts
if (res.status === 401 || res.status === 403) {
  throw new SyncError('auth_invalid', `oura: token rejected (HTTP ${res.status})`);
}
if (res.status === 429) {
  throw new SyncError('rate_limited', 'oura: rate limit exceeded');
}
if (!res.ok) {
  throw new SyncError('api_error', `oura: HTTP ${res.status}`);
}
```

The adapter's catch path calls `writeStateError(db, 'oura', toErrorRecord(err))`. Notification evaluator inspects the row and fires `oura-auth-invalid` when `last_error_reason === 'auth_invalid'`.

#### Reused generic mechanisms

- Per-adapter sync-failure condition (driven by `consecutive_sync_failures`) — fires automatically.
- Daemon-heartbeat-stale — adapter-agnostic.
- Frontier-not-advancing (if implemented today) — adapter-agnostic.

#### Explicit non-notifications

- **Ring not worn / no sessions for a date.** Absence isn't a failure. Harness sees `longest_minutes: 0` on a confirmed date and acts accordingly.
- **Late-arriving sessions.** Expected behavior. Confidence captures it.
- **Multiple sessions per day.** Normal.
- **Epoch invariant break.** Surfaces as a generic sync failure with a descriptive message. No dedicated condition; the generic sync-failure condition handles it.

### File layout

New files:

```
src/records/aasm.ts                          # AASM_SLEEP_STAGE constants, AASM coding URI
src/adapters/oura/index.ts                   # buildOuraAdapter, sync entry point
src/adapters/oura/api.ts                     # /usercollection/sleep fetch + error mapping
src/adapters/oura/parser.ts                  # parse session JSON → observations + epoch verify
src/adapters/oura/sleep-stage.ts             # OURA_SLEEP_STAGE constants, native coding URI
src/adapters/oura/sleep-stage-mapping.ts     # OURA_TO_AASM mapping, registered with taxonomy registry
src/adapters/oura/storage.ts                 # source_doc + observation insertion
src/adapters/oura/confidence.ts              # OuraConfidenceProvider implementation
src/adapters/oura/auth-config.ts             # PAT credential shape + key constant
src/adapters/oura/connect.ts                 # CLI/setup flow for storing the PAT
src/mcp/longest-continuous-tool.ts           # new MCP tool registration
src/query/longest-continuous.ts              # SQL + algorithm for longest-run query
```

Test files alongside each (`*.test.ts`).

Refactored files:

```
src/adapters/index.ts                        # add ConfidenceProvider, registry routing
src/adapters/fitbit/confidence.ts            # implement ConfidenceProvider; export shape
src/query/sqlite-archive.ts                  # use registry for confidence/freshness
src/mcp/server.ts                            # register new MCP tool
src/mcp/schemas.ts                           # GetLongestContinuousPeriodInputSchema
src/db/schema.ts                             # (no changes — adapter_state, source_documents, observations all generic)
src/notifications/conditions.ts              # add oura-auth-invalid
```

The Node subpath imports (`#adapters`, `#query`, etc.) keep cross-module dependencies visible at a glance. No new top-level submodule is needed; everything fits under existing barrels.

## Out of V1 scope

| Deferred item                                                                   | Why not now                                                                                                   |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Force-refresh window for Oura                                                   | Sessions are immutable in practice; add only if we observe stale data                                         |
| Per-stage LOINC observations as separate rows (93829-0/93830-8/93831-6 per run) | Aggregates already stored; per-run native observations already cover the timeline; redundancy isn't justified |
| Ring-worn signal / "did the user actually wear the ring"                        | Absence-of-data is the user's information; pure-time confidence rule already conveys it                       |
| Multi-adapter AASM composition                                                  | Only Oura today; composite-aggregation interface designed, implementation deferred                            |
| Stage-level drill-down MCP tool                                                 | Generic tool + AASM canonical coding covers everything V1 needs                                               |
| Backfill beyond 31 days                                                         | `window_days` max is 31; if deeper history matters later, a one-off backfill subcommand is cheap to add       |
| Raw signal storage (heart_rate, hrv, movement_30_sec from Oura responses)       | Direct measurements that LOINC could code, but not needed for V1 reporting                                    |
| Sleep efficiency at finer than per-session granularity                          | Per-session LOINC observation suffices                                                                        |

## Verification items for the implementation session

These are intentionally left "verify before locking" rather than locked at design time:

1. **Exact LOINC codes for Sleep Efficiency and Sleep Onset Latency.** Confidently verified in design: TST (93832-4), REM/Light/Deep (93829-0/93830-8/93831-6), WASO (103215-0). SE and SOL need lookup against the LOINC database before writing the parser.
2. **Epoch invariant in practice.** Confirm `len(sleep_phase_5_min) × 300 ≈ session duration` holds across real Oura responses (no off-by-epoch issues at session boundaries).
3. **Oura `day` field vs. recomputed `end_local_date`.** Decide whether to trust Oura's `day` attribution or compute from `bedtime_end + offset`. Likely identical, but worth a one-time check on real data.
4. **PAT credential persistence shape.** Confirm `adapter_credentials.credentials_json` shape works for a non-OAuth token (just `{ access_token }`); no schema change expected.
5. **Final coding URIs.** `https://vitals.fhwang.net/coding/aasm/sleep-stage` and `https://vitals.fhwang.net/coding/oura/sleep-stage` confirmed; document the convention in a code-level comment near where these constants live.

## Handoff

After this design is committed, the next steps are:

1. **Plan** — Use `superpowers:writing-plans` to produce a step-by-step implementation plan against this design.
2. **Worktree** — Create `feat-oura-sleep` via `claude -w oura-sleep`. Run `pnpm install` then `pnpm check` in the worktree as a clean-baseline verification.
3. **Execute** — TDD per `superpowers:test-driven-development`, with `pnpm check` passing at each step. Code review via `superpowers:requesting-code-review` before merging.
