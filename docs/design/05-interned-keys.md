# 05 — Interned Attribute Keys (Phase 1) + Work Plan

Status: **Complete (Phase 1).** Implemented in `packages/core/src/index.ts` + new
`packages/core/src/interned-keys.test.ts`. Phase 2 (numeric interning of string entity
ids, value interning) is deliberately deferred — see "Phase 2 (deferred)" below.

## Goal

Make the internal EAVT / AEVT / AVET indexes (and the live-query dependency maps)
keyed by small **numeric attribute ids** instead of raw ident strings, and
canonicalize repeated string instances, so:

- hot lookups hash SMIs instead of strings (`eavt.get(eid)?.get(attr)` is the hot path
  of the query engine),
- every distinct attribute ident is stored **once** (no duplicate string objects for the
  same content arriving from different call sites),
- transient derived-string churn is reduced where it touches attributes.

All of this is **internal only** — the public API (`Fact` tuples, `entity()` states,
snapshots, wire) keeps user-facing strings and numbers unchanged.

## Why not numeric entity-id keys in Phase 1

String entity ids (`'user:2'`, UUIDs) are a first-class public feature
(docs/design/01: `EntityId = number | string`). Interning them to numbers requires an
internal id space that can never collide with user numeric eids — impossible to
guarantee without reserving a range and imposing a new public constraint. Phase 1
therefore keeps `EntityId` (number | canonical string) as entity keys and only
canonicalizes string instances. This captures the dedup win while keeping index entry
slots identical (8-byte reference either way).

## Data structure changes (all in `packages/core/src/index.ts`)

- `EAVTIndex = Map<EntityId, Map<number, Fact[]>>` — entity → attrId → facts
- `AEVTIndex = Map<number, Map<EntityId, Fact[]>>` — attrId → entity → facts
- `AVETIndex = Map<number, Map<string, Fact[]>>` — attrId → valueKey → facts
- `uniqueIndex: Map<number, Map<string, Set<EntityId>>>` — attrId → valueKey → holders
- `AccessTracker.attributes: Set<number>`, `eidsByAttribute: Map<number, Set<EntityId>>`
- `LiveHandle.explicitDeps: ReadonlySet<number> | null`, `dependencies: Map<number, Set<EntityId>>`
- New interner fields:
  - `attributeIds: Map<string, number>` (ident → id; its keys are the canonical idents)
  - `attributeIdents: Map<number, string>` (id → canonical ident)
  - `nextAttributeId: number` (starts at 1; internal-only id space)
  - `canonicalStrings: Map<string, string>` (content → canonical instance, for string eids)
- New helpers: `internAttribute(ident)` (allocating), `canonicalString(s)`,
  `canonicalEid(eid)`.
- `attributeSchemas`, `schemaByIdent` stay ident-keyed (read-side, user-facing).

Invariants:
- **Intern on write** (`appendFact`, `maintainUniqueIndex`, live tracking); **look up
  non-mutating on read** (`attributeIds.get`) so a never-written attribute yields "no
  data", exactly like today's missing-map-key behavior.
- id assignment order has no observable effect: index iteration order comes from
  first-write insertion order, never from interner order; ids are never exposed.
- Restore rebuilds the interner in replay (tx) order → deterministic, matches the
  original database observably.

## Implementation checklist

- [x] 1. Index type aliases (`EAVTIndex` / `AEVTIndex` / `AVETIndex`) → attrId keys
- [x] 2. `AccessTracker` and `LiveHandle` types → attrIds
- [x] 3. `FactDatabase` fields: interner maps + counter; `uniqueIndex` → attrId
- [x] 4. Helpers: `internAttribute`, `canonicalString`, `canonicalEid`
- [x] 5. `appendFact`: canonical eid/attribute, intern attribute, key indexes by attrId
- [x] 6. `maintainUniqueIndex` / `scanUniqueHolders` / `activeUniqueHolders` → attrId
- [x] 7. Read APIs: `getFactsByAttribute`, `getFactsByEntityAttribute`,
      `getFactsByAttributeValue` → attrId lookup (undefined ⇒ `[]`)
- [x] 8. `entity()`: translate attrId → ident when building state
- [x] 9. Query engine: `attributeValues`, `hasAttributeValue`, `addAvetCandidates`,
      `candidateEidsForClause` → attrId lookup
- [x] 10. Live machinery: `find`/`query` tracking adds interned ids;
      `wrapTrackedEntity` proxy; `buildLiveHandle` explicit deps;
      `updateLiveDependencies`; `liveFactRelevant`; `transact` `newPairs`
- [x] 11. Validation: `validateMutations` `uniqueState` + `enforceUniqueValue` → attrId
- [x] 12. New tests (packages/core/src/interned-keys.test.ts): canonicalization,
      string-eid behavior, restore determinism, live with string eids, index APIs
- [x] 13. Validation: `npm run build`, `npm run types`, full core vitest suite,
      benchmark (packages/core) — no regressions vs pre-change
- [x] 14. Independent review of the diff for missed index-touch sites

## Validation results (2026-08-15)

- `npx tsc --noEmit` (core) clean; root `npm run types` (all workspaces) clean (EXIT 0).
- Core vitest suite: **228 tests pass** (214 pre-existing + 14 new).
- Cross-package vitest suites all pass against the rebuilt core dist:
  client 34, server 13, devtools 74, persistence 32, chrome-extension 2, examples 11,
  react 8, schema-designer 20 → 422 total.
- `npm run lint` (core) clean.
- Benchmark (10k entities / 20k facts): ingest 25 ms, single-clause query 2.9 ms,
  2-clause join 8.8 ms, find 0.9 ms — all targets PASS.
- The proxy `get` handler in `wrapTrackedEntity` was converted to an arrow function so
  `this` binds to the database (method-shorthand `get` binds to the ProxyHandler).

## Known notes

- Fact tuples keep user-facing eids/attributes (public contract); the canonicalization
  guarantees one string instance per distinct content. Numeric ids never leak.
- **Read-path interning is intentional**: live tracking (`find`/`query` criteria,
  entity proxies, explicit deps) interns attribute idents so a tracked-but-never-written
  attribute has an id for `liveFactRelevant` to match the very first write (the
  new-pair path). This makes the interner a superset of the written attributes in a
  live session; it is unobservable (ids are never exposed, no code iterates the
  interner, and index iteration is insertion-ordered), but restore() rebuilds a
  strictly fact-log-pure interner.
- **Validation-path interning**: `enforceUniqueValue` interns during validation, so an
  aborted transaction can leave an allocated id behind. Observably irrelevant (same
  reasons as above); flagged as a latent divergence hazard only if the id space is ever
  iterated or serialized.

## Validation

- Full core test suite (hand-written + fast-check property model — property tests use
  string eids `'alpha'`/`'beta'`, so they cover the canonicalization path).
- Benchmark `npm run benchmark` (packages/core): ingest/query/join/find targets must
  stay PASS; compare timing before/after.
- New focused tests (step 12).

## Phase 2 (deferred)

- Numeric interning of string entity ids in index keys — requires a reserved id-space
  strategy + public-constraint decision (collision with user numeric eids).
- Value interning for AVET `valueKey` strings (same pattern as attributes).
- Packing the transient `${eid}:${attribute}` validation keys / `livePairKey` as
  numeric pairs.

## Resume instructions

If work is interrupted mid-implementation:

1. Re-read this file and check off completed steps.
2. `git status` / `git diff packages/core/src/index.ts` to see partial edits.
3. Verify the invariant list above still holds for whatever is edited.
4. Continue from the first unchecked step, then run the step-13 validation.

Key risk to re-check after any partial edit: every `this.eavt/this.aevt/this.avet`
access must use an attrId for the attribute level, and every consumer of a nested-map
key inside `entity()` must translate attrId → ident.
