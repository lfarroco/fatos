# 04 — Implementation Phasing

Status: **Approved.** Work should be sequenced P0 → P4. Each phase lists concrete tasks,
acceptance criteria, and dependencies, and ties back to the roadmap in PLAN.md.

## Phase map

| Phase | Theme | PLAN.md tie-in | Depends on |
|---|---|---|---|
| P0 | Engine correctness & performance (blocker) | Phase 1 (core) hardening | — |
| P1 | Transact & query surface (`insert`/`pull`/operators) | Phase 1/2, schema-designer | P0 |
| P2 | Reactivity (live queries, EventTarget, React) | Phase 2 (reactive queries) | P0 |
| P3 | Wire & hygiene (JSON tags, `/query`, WS subscribe) | Phase 3 (server) | P1, P2 |
| P4 | Moat features (DevTools inspector, time travel) | Phase 4, 6 | P1 (diff), P2 (streaming) |

## P0 — Engine correctness & performance

**Tasks**
- Make `entity`, `find`, `query`, `activeValues` actually use EAVT/AEVT/AVET indexes
  (today they full-scan `facts`; measured join over 10k entities ≈ 7 s).
- Add `ref()` / `temp()` / `Date` / `BigInt` value support; reject opaque object values.
- Temp resolution at commit (fresh ids, same-tempid aliasing within a tx).
- `Object.freeze` entity state; stable result ordering everywhere.
- Schema additions needed by P1: `db/unique`, `db/ref`.
- Cross-package import cleanup + `@types/ws` so `npm run build` and `npm run types` are
  green for every workspace.

**Acceptance (benchmark suite, 10k entities / 20k facts)**
- ingest < 200 ms
- single-clause query < 10 ms
- 2-clause datalog join < 50 ms
- `find` by single attribute value < 10 ms
- all existing tests stay green; new tests for temp resolution and value validation

## P1 — Transact & query surface

**Tasks**
- `db.insert` (object maps + nested graph flattening), `db.upsert`, `db.set`, `db.patch`.
- `find` operators (`$eq $ne $gt $gte $lt $lte $in $nin $exists $contains`) +
  `orderBy / limit / offset / select`.
- `db.pull` dot-path selection.
- `db.at(tx)` rename (keep `atTransaction` alias) and `db.diff(txA, txB)`.
- Schema: `db/unique`, `db/ref` enforcement.

**Acceptance**
- Integration test suite: `insert → pull → upsert → diff` round-trip.
- Schema-designer relationship import maps to `ref` valueType (not `number`).
- Existing API (`add`/`retract`/`transact`/`entity`/`query`) unchanged.

## P2 — Reactivity

**Tasks**
- `db.live(fn)` access tracking + `db.live(deps, fn)` explicit-dependency variant.
- Client extends `EventTarget`; `subscribe` becomes sugar.
- `db.liveQuery(spec, { signal })` async iterable.
- React: selector-based hooks + stable memoized snapshots (fixes re-render-everything).

**Acceptance**
- Unit tests: no notification on unrelated writes; React bails out on unrelated writes;
  async iterable yields initial + deltas; `dispose`/`AbortSignal` stop delivery.

## P3 — Wire & hygiene

**Tasks**
- JSON type tags + reviver (`$ref`, `$date`, `$bigint`).
- `POST /query` REST endpoint.
- WebSocket `subscribe` registry with `afterTx` catch-up.
- Finish any remaining cross-package import / type hygiene from P0.

**Acceptance**
- Server tests for `/query` and WS subscribe (including catch-up after re-subscribe).
- Round-trip tests for tagged values across REST + WS.

## P4 — Moat features

**Tasks**
- DevTools inspector UI: fact table, entity view, query console, timeline — built on
  `db.diff` / `db.at`.
- Schema designer → typed schema bridge (consumes `db/unique`, `db/ref`).
- Time-travel UI (replay a tx range against a snapshot).

**Acceptance**
- The extension panel shows a running app's facts, timeline, and query results live.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Proxy tracking perf in `live` | Data-driven path stays primary; `live(deps, fn)` variant has no Proxy |
| Nested-graph flattening ambiguity (arrays of objects + refs) | Deterministic depth-first order + round-trip tests |
| Type-level schema typing scope creep | Deferred behind P4; document the contract first (see data-model doc) |
| Unique-index build cost | One extra index per unique attribute, maintained at commit |

## Open questions

1. Should P0 also land `db/unique` and `db/ref` schema attributes? *(Leaning: yes — they
   are cheap once P0 index work exists and P1 needs them.)*
2. The benchmark numbers above are targets to validate, not guarantees — confirm they are
   acceptable to tune after measurement.
