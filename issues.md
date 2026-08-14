# Issues & Work Log

This file tracks issues discovered while implementing the remaining tasks in
[PLAN.md](PLAN.md) and the approved design docs in [docs/design](docs/design).

Format:

```
## [YYYY-MM-DD] <area> — <short title>
- **Task**: <task id / description>
- **Found by**: <who found it>
- **Severity**: <high | medium | low>
- **Status**: <open | fixed>
- **Description**: ...
```

---

## [2026-08-14] core — P0 value model & schema support (design/01) implemented
- **Task**: P0 value model & schema support (docs/design/01-data-model.md, docs/design/04-phasing.md P0)
- **Found by**: P0 value model implementation (packages/core)
- **Severity**: low
- **Status**: fixed
- **Description**: Landed `ref()`/`temp()`/`lookupRef()` (Symbol-branded), tempid
  resolution at commit, Date/BigInt values, opaque-object rejection,
  NaN/±Infinity rejection, and `db/unique`/`db/ref` schema attributes with
  `'value'` uniqueness + ref enforcement. Existing tests whose expectations
  legitimately changed per the new rules were updated (see below); all other
  tests stayed green. Design deviations/limitations recorded:
  - **Arrays are kept verbatim as values** in P0. The data-model doc says
    arrays "expand to cardinality-many facts" — that is the P1 `insert` object
    grammar; the existing `add`/`transact` tuple surface stored arrays as
    opaque values and that behavior was preserved (pinned by entity.test.ts
    and the property suite). Documented as a P1 item.
  - **Bare `temp()` in value position is rejected** ("temp() can only be used
    as an entity id or wrapped in ref()"). The doc lists `temp()` as "usable as
    a value", but storing an implicit id reference contradicts "a plain number
    is never a reference"; callers must write `ref(temp(...))`. Revisit in P1.
  - **`lookupRef()` is stored as-is** in P0 (branded object in the fact log);
    resolution against `db/unique: 'identity'` is the P1 upsert.
  - **Cardinality-one / unconstrained retract matching stays Object.is** (pinned
    -0/+0 test). Consequence: retracting a Date or ref value requires the exact
    stored reference; equal-ms Dates / equal-target refs match only on
    cardinality-many attributes (value-key based). Consider value-key retract
    matching in P1.
  - **Datalog `query` constants are still `QueryTerm`-typed** (string/number/
    boolean/null), so Date/BigInt/ref constants don't typecheck in `where`
    clauses, and at runtime a Date constant matches only by reference on
    cardinality-one attributes. `find()` matches Date/BigInt/ref by canonical
    value key (ms epoch / bigint string / ref target) as required.
  - **`db/unique: 'value'` enforcement is O(entities × facts)** per unique
    attribute (walks the AEVT index); the risk-table "one extra index per
    unique attribute, maintained at commit" optimization is deferred to P1.
- **Resolution**: new value model in core/src/index.ts (brands, helpers,
  validation, tempid resolution, schema unique/ref) + new values.test.ts
  (32 tests). Validation: core build/typecheck/tests green (124 tests),
  client/server typecheck + tests green, examples typecheck green.

## [2026-08-14] core — P1 transact & query surface (design/02) implemented
- **Task**: P1 transact & query surface (docs/design/02-transact-and-query.md, docs/design/04-phasing.md P1)
- **Found by**: P1 implementation (packages/core, packages/schema-designer)
- **Severity**: low
- **Status**: fixed
- **Description**: Landed `db.insert`/`db.upsert` (object maps, deterministic
  depth-first/parent-major nested graph flattening, array expansion,
  `db/unique: 'identity'` upsert + lookupRef resolution), `db.set`/`db.patch`
  (diff-based retract+add in one transaction), find operators
  (`$eq $ne $gt $gte $lt $lte $in $nin $exists $contains`) with
  `orderBy / limit / offset / select`, `db.pull` dot-paths, `db.at` /
  `db.atTransaction` / `db.diff`, datalog operator clauses +
  Date/BigInt/ref constants with per-clause candidate sets, and a
  commit-maintained unique index. The deferred P0 items are resolved:
  - **Array expansion** (was: arrays kept verbatim): `insert` expands arrays
    into cardinality-many facts, auto-declaring `cardinality: 'many'` schema
    and rejecting arrays on cardinality-one attributes. The `add`/`transact`
    tuple surface still stores arrays verbatim (pinned by entity.test.ts).
  - **lookupRef upsert resolution** (was: stored as-is): `insert`/`upsert`
    resolve lookupRef values against `db/unique: 'identity'` holders into
    `ref()` (raising when unresolvable), and identity attributes match
    existing entities (plain value or lookupRef; `db/unique: 'value'`
    duplicates still raise). `add`/`transact` still store lookupRef as-is
    (pinned by values.test.ts).
  - **Datalog query constants** (was: QueryTerm-only): `QueryClause` value
    terms now accept find operator objects and Date/BigInt/ref/lookupRef
    constants; one-valued matching uses the canonical value key for
    non-QueryTerm constants (equal-ms Dates / same-target refs match).
    Variables still bind only QueryTerm values into result rows, so
    non-QueryTerm values participate as constants but cannot be projected
    (rows stay `QueryTerm[][]`).
  - **Unique-index optimization** (was: O(entities × facts) per unique attr):
    `uniqueIndex` (attribute → valueKey → holder ids) is maintained at commit
    and serves `db/unique: 'value'` enforcement + identity upsert lookups;
    lazily scan-backfilled when a unique constraint is added to pre-existing
    facts (schema is data). Defensive copies keep a failed transaction from
    mutating the committed index.
  - **Cross-variable datalog joins** (separate entry below): per-clause
    candidate sets — an unbound entity variable ranges over its own clause's
    candidates in global first-fact order.
- **New limitations / behaviors recorded**:
  - Same-tx retract-then-re-add of an existing cardinality-one value used to
    raise a false "Cardinality conflict" (validateMutations re-read the
    committed value after the retract); per-transaction retraction tracking
    (`oneRetracted`) now makes `set`/`patch` diff updates work.
  - Find/query operators match ANY member of cardinality-many attributes
    (e.g. `$ne` matches an entity when any member differs); `$exists`
    distinguishes null from missing; bare values are `$eq`.
  - `find` criteria values must be scalars or operator objects; plain objects
    throw "Unknown find operator".
  - `pull` path grammar: at each level the longest segment prefix joined with
    '/' names the attribute (so `user.name` reads `user/name`); terminal ref
    attributes return `{ id }`; many-valued refs yield arrays; multiple paths
    deep-merge.
  - Schema-designer relationships now declare `valueType: 'ref'` (not
    'number') and wrap data mutations in `ref(...)`; the package gained a
    dependency on `@fatos/core`.
- **Resolution**: core/src/index.ts (insert/upsert/set/patch/pull/at/diff,
  operators, per-clause query joins, unique index) + new
  transact-query.test.ts (42 tests); schema-designer/src/index.ts + tests.
  Validation: core build/typecheck/tests green (167), schema-designer
  typecheck + tests green (10), client/server/react/examples typecheck +
  tests green, benchmark targets met (single-clause best ~5.8 ms avg ~8 ms,
  2-clause join best ~15 ms, find ~1.7 ms).

## [2026-08-14] core — existing-test expectation updates for the new value rules
- **Task**: P0 value model (packages/core)
- **Found by**: P0 value model implementation
- **Severity**: low
- **Status**: fixed
- **Description**: Tests that stored values the new rules reject were updated:
  - entity.test.ts: "round-trips opaque object and array values" split —
    opaque objects now throw (`/opaque objects/`), arrays still round-trip;
    the Object.is test dropped its NaN half (NaN is no longer storable) and
    now pins only -0/+0 distinctness for unconstrained attributes.
  - properties.test.ts: NOTE_POOL dropped `{ nested: true }` and NaN; the
    "accepts arbitrary values" arbitrary generator dropped `fc.constant({x:1})`.
  - schema.test.ts: "unknown value type accepts anything" now uses supported
    values (`new Date(0)`, `10n`, `[1, 2]`) and asserts opaque objects are
    rejected regardless of schema.
  - packages/schema-designer: its standalone `ValueType` union and
    `isValueType` validator were extended with `'date' | 'bigint' | 'ref'` to
    stay assignable with the widened core `ValueType` (examples typecheck
    depends on it).

## [2026-08-13] core — benchmark targets missed for query & datalog join
- **Task**: P0 benchmark (docs/design/04-phasing.md P0)
- **Found by**: core P0 engine work, `npm run benchmark` (packages/core)
- **Severity**: medium
- **Status**: fixed
- **Description**: 10k entities / 20k facts. ingest avg 84 ms (< 200 ms PASS),
  find by attribute value avg 8 ms (< 10 ms PASS), but single-clause query avg
  30 ms (target < 10 ms, FAIL) and 2-clause datalog join avg 80 ms
  (target < 50 ms, FAIL). Root cause appears to be `candidateEidsForCriteria`
  iterating every EAVT key (O(entities)) plus full entity reconstruction per
  candidate, and the datalog join re-scanning candidates per clause. Per
  04-phasing.md these are "targets to validate, not guarantees" — being routed
  back to a sub-agent for optimization.
- **Resolution**: rewrote `query()` in core/src/index.ts to use positional
  array bindings (no per-row `Record` spreads), per-binding EAVT index access
  for joins (no per-clause materialization of `(eid, value)` triples plus a
  string-keyed group map), and a non-allocating `hasAttributeValue` check for
  constant-value clauses (replaces the `clauseTriples` scan). Removed the now
  unused `bindTerm`/`clauseTriples`. Added fast-path tests in query.test.ts
  (value-change exclusion, retraction-aware join, many-valued join order,
  cross-variable join order, tx-scoped join). Measured on the P0 benchmark
  (packages/core, 5 runs each): single-clause avg ~7.6 -> ~7.0 ms (best 6.9 ->
  3.9 ms; amortized 3.6 ms/query), 2-clause join avg ~13.6 -> ~10.4 ms
  (amortized 7.4 ms/query). Both targets met: single-clause < 10 ms,
  join < 50 ms.

## [2026-08-13] core — cross-variable datalog joins are narrowed to the candidate intersection (pre-existing)
- **Task**: P0 query engine (fast-path rewrite, `npm run benchmark`)
- **Found by**: query engine optimization work (packages/core)
- **Severity**: low
- **Status**: fixed
- **Description**: `candidateEidsForQuery` intersects every clause's eid set,
  and the engine iterates that intersection for any clause whose entity
  variable is not yet bound. For a join on two *different* entity variables
  (e.g. `[?a 'type' 'user'] [?b 'age' ?age]`) this restricts `?b` to the
  shared intersection instead of letting it range over all entities matching
  its own clause — narrower than textbook datalog semantics. Preserved
  deliberately for identical observable behavior (pinned in
  query.test.ts "joins two distinct entity variables in candidate order").
- **Resolution**: P1 rewrote the join to use per-clause candidate sets
  (`candidateEidsForClause`): an unbound entity variable ranges over the
  entities matching ITS OWN clause, ordered by global first-fact order, so
  result ordering stays deterministic. Same-entity-variable joins keep the
  per-binding EAVT fast path (no benchmark regression). Pinned test updated
  and extended with a case where the per-clause sets differ
  ("does not narrow distinct entity variables to the shared candidate
  intersection").

## [2026-08-13] repo — `npm run types` fails at root (missing scripts)
- **Task**: P0 hygiene (docs/design/04-phasing.md P0)
- **Found by**: orchestrator baseline check
- **Severity**: medium
- **Status**: fixed
- **Description**: `@fatos/examples` package.json lacks a `types` script, so
  `npm run types` at the repo root aborts with "Missing script: types".
  `@fatos/chrome-extension` also lacks a `types` script. Expected every
  workspace to expose `types` (and `lint`) like the other packages.
- **Resolution**: added `"types": "tsc --noEmit"` to `packages/examples` and
  `packages/chrome-extension` package.json, added `"lint": "eslint src"` to
  `packages/examples`, and added `@types/ws` (missing) to `packages/server`
  devDependencies (ws is a dependency there). Root `npm run types` now exits 0
  for all 9 workspaces.

## [2026-08-13] repo — `eslint src` cannot parse test files (pre-existing)
- **Task**: P0 hygiene (lint scripts exist on every workspace)
- **Found by**: core P0 engine work, lint verification
- **Severity**: low
- **Status**: open
- **Description**: `.eslintrc.json` uses `parserOptions.project` pointing at each
  package's tsconfig, but every tsconfig excludes `**/*.test.ts`/`*.spec.ts`, so
  `eslint src` fails with "Parsing error ... TSConfig does not include this
  file" on every test file in every package. This predates the P0 work and is
  repo-wide; `npm run lint` was already broken before these changes. Fixing it
  requires either excluding test files from the lint glob or a dedicated
  tsconfig for tests (out of scope for P0 engine work).

## [2026-08-13] Workflow note

Remaining tasks are being completed in sequence by spawned sub-agents. After each
step the work is validated (`npm run build`, `npm run types`, `npx vitest run` per
package) and committed. Issues found during validation are logged here and routed
back to sub-agents for fixes.
