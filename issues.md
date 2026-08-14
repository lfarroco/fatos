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

## [2026-08-14] schema-designer — Phase 7 relationship editing flow implemented
- **Task**: Phase 7: Add relationship editing flow (one-to-one, one-to-many, many-to-many)
- **Found by**: schema-designer implementation (packages/schema-designer)
- **Severity**: low
- **Status**: fixed
- **Description**: Landed the full relationship editing flow. New editor helpers:
  `updateRelationship(document, id, patch)` (name/fromCardinality/
  toCardinality/referenceAttributeName), `removeRelationship(document, id)`,
  `defaultReferenceAttributeName(targetName)` (camelCase + `Id` suffix, e.g.
  `Org` -> `orgId`), and `formatCardinalityHint(from, to)` (`1 — n`, `n — m`,
  ...). Notable behaviors/limitations recorded:
  - **Duplicate relationship names are now rejected in `addRelationship`**
    (trimmed comparison against existing names). Self-references and missing
    entity ids were already rejected; both are now pinned by tests.
  - **`updateRelationshipName` now delegates to `updateRelationship`**, so empty
    names are ignored (keeps the previous name) instead of being stored
    verbatim; names are trimmed. This is a small semantic tightening of the
    existing helper.
  - **`updateRelationship` treats a blank `referenceAttributeName` patch as
    "clear"** (stored as `undefined`); omitting the field keeps the current
    value. A relationship can therefore be edited back to using the
    `<Target>Id` default at adapter time.
  - **The default reference attribute name is now camelCase** (`orgId`) via
    `defaultReferenceAttributeName`; the adapter (`toFatosTransactionEntries`)
    previously fell back to `${targetEntity.name}Id` verbatim (`OrgId`). The new
    default matches the existing test fixtures; only documents that relied on
    the un-camelCased fallback would see a different emitted ident.
  - **Canvas labels** are now clickable (selects the relationship), show the
    cardinality hint and resolved reference attribute name, and highlight when
    selected; the right panel gained selectable relationship rows plus a
    Relationship Inspector (name, from/to cardinality, reference attribute,
    Delete). The connect form pre-fills `<Target>Id` and refreshes it when the
    target changes unless the user customized it.
- **Resolution**: editor.ts (2 new helpers + 1 new type, duplicate-name
  validation), index.ts exports + adapter fallback, react.ts inspector/select/
  delete/label flow, +9 tests (18 total in package). Validation: build +
  typecheck + vitest green; examples typecheck green.

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

## [2026-08-14] devtools + chrome-extension — P4 inspector UI has no snapshot producer yet
- **Task**: P4 DevTools inspector UI (fact table, entity view, timeline, diff,
  query console) — docs/design/04-phasing.md P4
- **Found by**: P4 inspector implementation (packages/devtools, packages/chrome-extension)
- **Severity**: medium
- **Status**: fixed
- **Description**: The panel now validates bridge snapshot payloads against the
  `FactSnapshot` contract defined in packages/devtools/src/snapshot.ts
  (`{ facts, transactions, capturedAt?, url? }`, values may be engine values
  or `$date`/`$bigint`/`$ref`/`$lookupRef` wire forms) and rebuilds a client
  from them, but **nothing in the repo publishes one yet**: `content.ts`
  relays page bridge payloads verbatim and no example/React wiring calls
  `createBrowserDevtoolsBridge().publishSnapshot(...)` with a facts +
  transactions payload. Until an inspected app publishes a valid
  `FactSnapshot`, the panel degrades to "waiting for snapshot" (with the
  controller's lastError shown when a malformed payload arrives). Follow-up:
  wire a snapshot producer into an example app (e.g. publish
  `{ facts: client.getFacts(), transactions: client.getTransactions() }` on
  every committed transaction). Note: `@fatos/client` re-exports neither
  `createDatabase` nor `deserializeValue`, so @fatos/devtools takes a direct
  `@fatos/core` dependency for the controller's restore/replay path.
- **Resolution**: landed the page-side producer —
  `installSnapshotPublisher(client, options?)` in packages/devtools (exported
  from the index) subscribes to `transaction:committed` writes and to the
  extension's `inspect-request` handler, builds a `FactSnapshot` (facts +
  transactions from the client, `capturedAt`, `url`), and publishes it via
  `createBrowserDevtoolsBridge().publishSnapshot(...)`. Values are serialized
  with `serializeValue` to their JSON-wire form first, so symbol-branded refs
  survive `postMessage`/`chrome.runtime.sendMessage` and the panel's
  `deserializeValue` replay is exact. Returns `{ publish(), dispose() }`;
  guards for no-window environments (install/publish/dispose all no-op).
  Verified `content.ts` already relays snapshot payloads verbatim (kind
  `snapshot` passes `isPageBridgeMessage` and is forwarded as-is), so no
  content/background changes were needed. Examples gained a self-contained
  browser harness (`examples/browser-harness.html` + `src/browser-harness.ts`,
  bundled to `dist/browser-harness.js` with `--no-external`) that seeds a demo
  client, installs the publisher, and offers add/toggle/transact/publish
  buttons so the panel shows live changes; README documents how to serve it.
  Validation: devtools build/typecheck green, devtools 40 tests (was 35),
  chrome-extension typecheck + 2 tests green, examples typecheck green + 11
  tests green.

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
- **Status**: fixed
- **Description**: `.eslintrc.json` uses `parserOptions.project` pointing at each
  package's tsconfig, but every tsconfig excludes `**/*.test.ts`/`*.spec.ts`, so
  `eslint src` fails with "Parsing error ... TSConfig does not include this
  file" on every test file in every package. This predates the P0 work and is
  repo-wide; `npm run lint` was already broken before these changes. Fixing it
  requires either excluding test files from the lint glob or a dedicated
  tsconfig for tests (out of scope for P0 engine work).
- **Resolution**: added `"**/*.test.ts"` and `"**/*.spec.ts"` to
  `ignorePatterns` in root `.eslintrc.json` (test files are type-checked by
  `tsc --noEmit`/vitest separately, so they don't need parserOptions.project
  linting). Verified `npx eslint src` exits 0 in server, core, client, and
  persistence.

## [2026-08-14] server — lint errors in src/index.ts (unsafe argument, no-base-to-string, unnecessary assertion)
- **Task**: repo-wide lint gate
- **Found by**: lint verification pass
- **Severity**: low
- **Status**: fixed
- **Description**: `packages/server/src/index.ts` had three
  `@typescript-eslint` errors: `no-unsafe-argument` in `readJsonBody` (async
  iteration over `IncomingMessage` yields `any`), `no-base-to-string` in the
  WS `message` handler (`RawData` union may stringify to `[object Object]`),
  and `no-unnecessary-type-assertion` on `txRaw as number | undefined` (the
  guard above already narrows it). No behavior change.
- **Resolution**: typed the request-body async iteration as
  `AsyncIterable<Buffer | string>`; decode WS `RawData` via
  `Array.isArray`/`Buffer.isBuffer`/`Buffer.from` guards before `.toString()`;
  dropped the redundant assertion. Server lint, typecheck, and tests green.

## [2026-08-14] core — pre-existing lint errors blocking `eslint src`
- **Task**: repo-wide lint gate
- **Found by**: lint verification pass
- **Severity**: low
- **Status**: fixed
- **Description**: once test files were excluded from linting, `packages/core`
  surfaced 10 pre-existing type-aware errors in `src/index.ts` that kept
  `npm run lint` non-zero (they were previously hidden among the test-file
  parsing errors): 3× `no-unsafe-assignment` (indexing `any[]` in
  `mergePullFragments`), 5× `no-unnecessary-type-assertion`, 1×
  `no-unsafe-return` (`Reflect.get`), 1× `no-this-alias`, 1× `unbound-method`.
- **Resolution**: behavior-preserving fixes — array iterations typed via
  `unknown[]` locals, redundant `as EntityId[]`/`as Set<EntityId>`/
  `as EntityId` assertions removed, `Reflect.get(...) as unknown`, dropped the
  `const database = this` alias (arrow-fn `dispose` uses lexical `this`),
  and `subscribe` wrapped in an arrow. Core lint, typecheck, and all 212
  tests green.

## [2026-08-13] Workflow note

Remaining tasks are being completed in sequence by spawned sub-agents. After each
step the work is validated (`npm run build`, `npm run types`, `npx vitest run` per
package) and committed. Issues found during validation are logged here and routed
back to sub-agents for fixes.

## [2026-08-14] core — P2 core reactivity (design/03) implemented
- **Task**: P2 reactivity core half (docs/design/03-reactivity-and-wire.md, docs/design/04-phasing.md P2)
- **Found by**: P2 core implementation (packages/core)
- **Severity**: low
- **Status**: fixed
- **Description**: Landed `db.live` (access-tracking `live(fn)`, explicit-deps
  `live(deps, fn)`, and direct `live(specOrCriteria)` forms) and
  `db.liveQuery(specOrCriteria, { signal })` in `packages/core` only. Access
  tracking wraps entity states returned by `entity`/`find` in a Proxy that
  records attribute reads; `find` criteria keys and `query` where-clause
  attributes are recorded as implicit dependencies even when the selector never
  touches the results (keeps `live(() => db.find(criteria))` correct). The
  recorded attribute set is expanded to candidate eids via the AEVT index, and a
  fact is relevant only if its attribute was recorded and (its entity was a
  candidate at the last evaluation or the fact introduces a brand-new
  (eid, attribute) pair — computed pre-append in `transact`). Results are
  memoized with a JSON-stable key (Date/bigint/ref-aware) and diffed; subscribers
  are notified only on actual change, once per transaction. `liveQuery` is an
  async iterable over `{ current, subscribe, dispose }` that yields the initial
  result then each change; AbortSignal / iterator `return()`/`throw()` /
  `dispose()` stop delivery. Documented limitations:
  - **Access tracking covers reads during `fn` only.** A selector that returns
    an entity without reading attributes (e.g. `() => db.entity(1)`) records no
    attributes and falls back to re-evaluating on every write (diffing still
    suppresses spurious notifications). Read the attributes you depend on.
  - **Dependency granularity is attribute-level** (plus AEVT candidate eids), so
    a write to a recorded attribute of any candidate entity re-runs the selector
    even if that entity is not in the result; result diffing filters the
    notifications.
  - **`find` with `select` drops the Proxy** (new objects are built), but the
    criteria keys are still recorded.
  - **Time-travel reads (`at`/`atTransaction`) inside a live selector are not
    tracked** (no Proxy there); live selectors read current state.
  - **`liveQuery` buffers every distinct change** while the consumer is idle; a
    slow consumer sees intermediate states (no coalescing to latest).
  - `EntityState` is now exported from `@fatos/core` (additive, previously
    internal) so the criteria-form live/liveQuery return types are usable.
- **Resolution**: new `live`/`liveQuery` machinery in core/src/index.ts
  (types, `stableValueKey`, `AccessTracker`/`LiveHandle`, Proxy wrapping in
  `entity`, tracking hooks in `find`/`query`, per-transaction `notifyLive`) +
  new live.test.ts (12 tests). Validation: core build/typecheck/tests green
  (179 tests), benchmark targets all PASS with no regression.

## [2026-08-14] core — live.test.ts has a describe() nested inside an it() callback
- **Task**: P2 client half (EventTarget + live/liveQuery delegation, packages/client only)
- **Found by**: P2 client implementation (packages/client)
- **Severity**: medium
- **Status**: fixed
- **Description**: In `packages/core/src/live.test.ts`, `describe('db.liveQuery',
  ...)` (line 245) is nested inside the `it('stops tracking and keeps current
  read-safe after dispose', ...)` callback (opened at line 229); the trailing
  `});` pairs close the nested describe and the outer `it`, so all five
  liveQuery tests (initial-result, for-await, AbortSignal, already-aborted,
  current/subscribe/dispose) register/execute inside the 'stops tracking'
  test's execution context rather than as top-level tests. Symptoms observed
  while implementing the client half of P2: vitest reports 12 tests for the
  file although it contains 17 `it(...)` calls; `--testNamePattern` never
  matches any of the nested tests; and the for-await liveQuery test's
  microtask timing is entangled with the outer test — a verbatim copy of that
  test in a fresh file needs two microtask turns for the first yielded value,
  while the nested version passes with one. The nested tests pass today, but
  the structure violates vitest's collection model and is fragile. Out of
  scope for the client-only P2 task; left for a core-package cleanup (the
  closing `});` of `it('stops tracking...')` should move before the
  `describe('db.liveQuery', ...)` block).
- **Resolution**: restructured `packages/core/src/live.test.ts` so all
  `describe` blocks are top-level: the dangling tail of `it('stops
  tracking...')` (late-subscriber assertions) was moved into its body, the
  `it` and `describe('db.live — dispose semantics')` are closed before the
  `describe('db.liveQuery', ...)` block, which now sits at module scope.
  vitest now collects all 17 tests for the file (was 12), and
  `--testNamePattern` matches the liveQuery tests. Moving the block exposed
  two things that the nested version had masked (its trailing `await`s were
  never actually awaited by vitest): (a) the for-await test's single
  `await Promise.resolve()` is one microtask short — an async generator takes
  two microtask turns to deliver its first yielded value — so both flushes
  were switched to a deterministic macrotask
  (`await new Promise((resolve) => setTimeout(resolve, 0))`); (b) the
  'yields the initial result' test awaited a third delivery after unrelated
  writes, which the (documented) result-diffing design never emits — it now
  asserts non-delivery via `Promise.race` and that `query.current` is
  unchanged, then stops the stream with `query.dispose()` instead of
  `iterator.return()` (see the new return()-while-idle issue below). All
  other assertions unchanged; each test still constructs its own db, so
  isolation is unaffected. Validation: core typecheck green; live.test.ts
  17/17 pass; full core suite green.


## [2026-08-14] react — P2 selector hooks land; design-doc live() selector signature differs from core
- **Task**: P2 React half (selector hooks + memoized snapshots, packages/react only)
- **Found by**: P2 React implementation (packages/react)
- **Severity**: medium
- **Status**: open
- **Description**: `docs/design/03-reactivity-and-wire.md` shows the access-tracking
  form as `db.live(db => db.find(...))` — the selector receives the database as
  an argument — but the implemented core `live(fn)` (packages/core) stores `fn`
  as the handle's `read` and calls it with **no arguments** (`evaluateLive` →
  `handle.read()`), and both core and client type the overload as
  `live<T>(fn: () => T)`. A caller following the design doc gets `undefined`
  as the `db` parameter. The new React selector hook
  (`useQuery((db: FatosClient) => T)`) keeps the design-doc selector shape and
  supplies the client from context itself (`client.live(() => selector(client))`),
  so the hook API is unaffected; the doc/core mismatch remains for direct
  `live(fn)` users. Options for later: pass the db into `fn` (breaking change to
  the no-arg type), or update the design doc + React hook signature to a
  no-arg selector.
- **Resolution**: react hook implemented with the client supplied from context;
  core/client untouched in this run.

## [2026-08-14] react — tests use react-test-renderer (deprecated) pinned to React 18 types
- **Task**: P2 React half (tests, packages/react only)
- **Found by**: P2 React implementation (packages/react)
- **Severity**: low
- **Status**: open
- **Description**: The vitest environment is `node` (root vitest.config) with no
  jsdom/happy-dom and no DOM shim in the repo, and `react-dom/client` needs a
  DOM. The P2 hook tests therefore use `react-test-renderer` (new devDependency,
  works without a DOM). React docs mark react-test-renderer deprecated (React
  19 removed it), and `@types/react-test-renderer` resolves to 19.x by default,
  which is incompatible with the React 18.3 types used here — it had to be
  pinned to `18.3.1`. When the repo upgrades to React 19, swap the tests to
  `react-dom/client` + a DOM environment or @testing-library.
- **Resolution**: devDeps added to packages/react only (`react-test-renderer@^18.3.1`,
  `@types/react-test-renderer@^18.3.1`); package-lock.json updated.

## [2026-08-14] core+server — P3 wire protocol implemented (JSON tags, /query, WS subscribe)
- **Task**: P3 wire & hygiene (docs/design/03-reactivity-and-wire.md "Wire protocol", docs/design/04-phasing.md P3)
- **Found by**: P3 wire protocol implementation (packages/core, packages/server)
- **Severity**: low
- **Status**: fixed
- **Description**: Landed JSON type tags + reviver in core (`serializeValue` /
  `deserializeValue` / `deserializeQuerySpec`, exported; wire forms `$ref` /
  `$lookupRef` / `$date` / `$bigint`), `POST /query` (`{ spec, tx? }` →
  `{ rows }`), and the WebSocket `subscribe` registry (subscribe → `subscribed`
  + `facts` pushes, unsubscribe, per-client registry, `afterTx` catch-up). The
  raw `fact:added`/`transaction:committed` fan-out over WS is unchanged. Design
  decisions and deviations recorded:
  - **`afterTx` catch-up sends the current query-result snapshot (rows), not
    fact-filtered-by-tx.** The catch-up message shape is `{ type: 'facts', id,
    rows }` (joined datalog rows, not raw facts), so "stream committed facts
    since that tx" is implemented as: send `live.current` rows at subscribe
    time (covering everything committed up to now — i.e. everything the client
    missed since `afterTx`) and then live updates. The client converges to
    authoritative state; this matches the P3 acceptance test (catch-up after
    re-subscribe).
  - **Datalog rows can never contain tagged values today.** The query engine
    binds only QueryTerms (string/number/boolean/null) — non-QueryTerm values
    (Date/bigint/ref) are skipped when binding variables — so `POST /query`
    `rows` and WS `facts` pushes are always plain JSON; `serializeValue` is
    still applied for future-proofing. Tagged **constants in specs** do work:
    `{ $date: ms }` etc. revive and match via the canonical value key.
  - **`GET /facts/:eid` (entity snapshot) and the SSE `/events` stream are
    unchanged** (per "keep the existing endpoints unchanged"): entity state
    containing Date/ref values still stringifies via JSON.stringify's defaults
    (ISO string / `{}`) there. Only the fact log (`GET /facts`, `/transact`
    responses), query rows, and WS subscribe pushes are wire-tagged.
  - **Invalid WS subscribe messages are silently ignored** — the design doc
    defines no error message, so malformed JSON, missing/non-string `id`,
    non-numeric `afterTx`, or an invalid spec get no reply.
  - **Re-subscribing with an existing id disposes the previous live handle**
    and replaces it (registry is keyed by client-chosen id per the doc's
    "one subscription registry per client").
- **Resolution**: wire helpers + tests in core (wire.test.ts, 23 tests);
  server: `POST /query`, tagged-value handling on `/transact` + `/facts` +
  `GET /facts`, WS subscribe registry with afterTx catch-up, tests in
  index.test.ts (+4). Validation: core build/typecheck/tests green (202
  tests), server build/typecheck/tests green (9 tests), client + examples
  typecheck green.

## [2026-08-14] core — liveQuery iterator `return()`/`throw()` hang while the stream is idle-pending
- **Task**: live.test.ts restructure (describe-inside-it fix)
- **Found by**: live.test.ts restructure validation
- **Severity**: medium
- **Status**: open
- **Description**: In `createLiveQueryResult` (packages/core/src/index.ts) the
  async generator idles on `await new Promise((resolve) => { resolveNext =
  resolve; })` when no change is queued. Per V8 async-generator semantics, a
  `return()`/`throw()` call issued while the generator is suspended at that
  `await` does not settle until the awaited promise itself resolves — which
  happens only on the next notification or `dispose()`. So
  `await iterator.return()` on an idle liveQuery stream hangs indefinitely
  (verified in isolation), even though design/03 promises "iterator
  `return()`/`throw()`/`dispose()` stop delivery". The old nested-in-`it`
  tests never exercised this (their `await`s were never awaited by vitest);
  the restructured standalone tests stop idle streams with `query.dispose()`
  instead. `dispose()` and AbortSignal paths are unaffected (dispose resolves
  `resolveNext`). Fix idea: give the generator a way to observe `return()`
  (e.g. wrap the iterator with an explicit `return()` that triggers the
  pending resolution, or resolve the idle await on a disposal flag), or
  document that consumers must call `dispose()` rather than `return()`.
- **Resolution**: none (documented; tests avoid the path for now).

## [2026-08-14] persistence — Phase 5 storage adapters + server wiring (design/04)
- **Task**: Phase 5 persistence (PLAN.md Phase 5; docs/design/04-phasing.md P0 "Cross-package import cleanup" follow-through: @fatos/persistence was a stub package)
- **Found by**: Phase 5 implementation (packages/persistence, packages/server, packages/core)
- **Severity**: low
- **Status**: fixed
- **Description**: Implemented the persistence layer and wired it into the
  server. Design decisions recorded:
  - **`StorageAdapter` contract**: `load(): Promise<DatabaseSnapshot>` (empty
    snapshot when the backend holds nothing), `save(snapshot): Promise<void>`,
    `close(): Promise<void>`. `DatabaseSnapshot = { facts, transactions }`
    lives in **@fatos/core** (it is the engine's restore input) and is
    re-exported by @fatos/persistence — one definition, no type drift.
  - **Snapshot replay is a new `FactDatabase.restore()` in core, not
    `transact()` re-entry.** Replaying stored facts through the public
    `transact` is provably wrong: committed schema facts carry negative eids
    (`[-1, 'db/ident', ...]`) and `transact` remaps negative eids as tempids,
    which would corrupt the schema on reload. `restore()` appends facts
    verbatim via the existing `appendFact`/`onFactCommitted` paths (indexes +
    schema rebuilt identically), validates ordering invariants (facts ascending
    by tx, tx sets match the ledger exactly), and continues `nextTx` after the
    max restored tx. This is an additive public API; core tests untouched and
    green (+5 restore tests).
  - **Persisted value encoding reuses the P3 wire tags** (`serializeValue` /
    `deserializeValue`: `$ref`/`$lookupRef`/`$date`/`$bigint`). File/postgres/
    mongo/indexeddb snapshots are JSON-safe and Date/bigint/ref values
    round-trip losslessly. Transaction metadata is tagged per top-level key.
  - **Save-on-every-transaction, ordered and async, not debounced.** `transact`
    stays synchronous (existing public API), so `persist()` queues snapshot
    saves on a promise chain: each save captures the db state right after its
    commit and runs strictly after the previous save (no interleaving, commit
    order preserved). Failures are captured and rethrown by the new public
    `flush()`; `stop()` also awaits the queue so a stopped server leaves a
    consistent snapshot. Debouncing was rejected: for small-to-mid DBs a full
    snapshot save per tx is simpler and crash-consistent; revisit if a write
    benchmark warrants batching.
  - **Driver injection, no new runtime deps.** Postgres takes a pg-shaped
    `SQLExecutor` (`{ query(sql, params) => { rows } }`, `$1` placeholders;
    documented `new PostgresAdapter({ query: (sql, p) => pool.query(sql, p) })`);
    Mongo takes a collection-like (`findOne`/`replaceOne` — a real mongodb
    Collection qualifies structurally). Neither adapter closes a driver it was
    handed. One table `fatos_snapshot(id INTEGER PRIMARY KEY, payload TEXT)` /
    one document `{ _id: 'fatos-snapshot', payload }`; save is a single atomic
    statement per backend.
  - **File adapter writes temp + rename** (same dir, pid/timestamp/random
    suffix) for atomic replaces; `load()` treats ENOENT as an empty snapshot
    and errors clearly on invalid JSON/shape. Parent dirs are created on save.
  - **IndexedDB adapter uses local structural IDB types** (the persistence
    tsconfig compiles with `lib: ES2020`, no DOM), accessed via
    `globalThis.indexedDB` with a clear error when unavailable; one object
    store, one record under a fixed key. Close() releases the cached
    connection; load/save reopen lazily.
  - **Server seeding happens once per instance** (`seeded` flag): the in-memory
    db survives start/stop cycles, so a second `start()` does not re-restore
    onto a non-empty db (restore() throws there by design).
- **Resolution**: core + restore.test.ts (5 tests); persistence package rebuilt
  from stubs (types.ts, serialization.ts, adapters file/postgres/mongodb/
  indexeddb/memory, index exports, package.json ./indexeddb + ./memory export
  subpaths, 27 new tests across memory/file/postgres/mongodb/indexeddb);
  server wiring (storage option, load+restore on start, persist-after-transact,
  flush(), stop() drains saves, createFatosServer(options?)) + 2 server tests.
  Validation: persistence build/typecheck/tests green (29 tests), server
  build/typecheck/tests green (11 tests), core tests green (212 tests).
  Open limitation: the IndexedDB adapter's runtime shape is verified only
  against the fake — a real-browser smoke test would be a follow-up.
