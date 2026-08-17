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
## [2026-08-17] core+client — G6: `db.transactionFacts(tx)` / `db.transaction(tx)` convenience
- **Task**: G6 (P3) — Convenience for "facts committed by tx N" / tx metadata
  (docs/niche-gap-tasks.md)
- **Found by**: G6 implementation (packages/core, packages/client,
  packages/app-replay)
- **Severity**: low
- **Status**: fixed
- **Description**: Consumers hand-rolled "what did tx N do": Replay's step-diff
  panel called `db.diff(tx - 1, tx)`, and audit panels filtered
  `getFacts()`/`getTransactions()` by hand. Added the direct convenience:
  - **`db.transactionFacts(tx)`** — the facts committed in transaction `tx`
    (empty when unknown).
  - **`db.transaction(tx)`** — the ledger record `[tx, timestamp, metadata]`
    for `tx`, or null when unknown.
  - **`FatosClient` passthrough** for both.
- **Resolution**: core: two methods next to `getTransactions` (+1 test:
  per-tx facts incl. a retract+add tx, unknown-tx empty/null, record with
  metadata); client: passthrough (+1 test); app-replay: the "This step
  (diff)" panel now reads `db.transactionFacts(activeTx)` and groups by op
  instead of `db.diff(tx - 1, tx)` (the acceptance criterion). Validation:
  core 240 tests green (was 239), client 63 (was 62), full suite 506 green,
  repo-wide typecheck clean, lint clean, core/client dist rebuilt.

---
## [2026-08-17] client — G10: persist the syncing mirror via an injected adapter
- **Task**: G10 (P2) — Persisting the syncing mirror (durable local cache)
  (docs/niche-gap-tasks.md; depends on G8's watermark derivation, done
  earlier today)
- **Found by**: G10 implementation (packages/client, docs/client-guide.md,
  docs/sync-strategies.md)
- **Severity**: low
- **Status**: fixed
- **Description**: The mirror lived only in memory, so a device that rebooted
  lost its cache. `createSyncingClient` now accepts an optional
  `adapter?: StorageAdapter` (type-only import from `@fatos/persistence`,
  added as a client dependency) and persists every applied transaction:
  - **Full pull / first catch-up** → `adapter.save(snapshot)` replaces the
    cache with the restored mirror (server tx numbers, metadata revived from
    wire tags — a `load()` → `restore()` round-trip reproduces the mirror).
  - **Live sync-event / incremental catch-up** → `adapter.append(transaction,
    facts)` per applied transaction (bound via `.bind(adapter)` so class-based
    adapters keep `this`); adapters without `append` fall back to a full
    snapshot `save()` of the mirror. Writes run on a serialized promise queue
    so commit order is preserved and failures surface via `onError`.
  - **Boot** → the first `handleOpen` defers the sync message until
    `adapter.load()` settles; a non-empty cache is restored into the mirror
    (server tx numbers preserved → the resume watermark is the cache ledger
    head) and `onClientReplaced` fires; an empty cache keeps the fresh client
    and full-pulls; an explicit `options.client` wins over the cache (no
    seeding). The syncing client never closes the adapter (caller-owned).
- **Resolution**: sync.ts `adapter` option + seeding (`startSeedingIfNeeded`,
  deferred `sendSyncMessage`) + persistence (`enqueuePersist` serialized
  queue, `persistTransaction`/`persistDelta`/`persistRebuild`,
  `mirrorSnapshot` no-append fallback) hooked into `applySnapshot`,
  `applyCatchUp`, `applyLiveTransaction`; client package.json gained
  `@fatos/persistence` (type-only use). Tests: sync.test.ts FakeAdapter
  (+4: append on full-pull save / live event / delta per-tx, seed-from-cache
  with watermark + `onClientReplaced`, empty-cache full-pull, provided-client
  wins over cache). Docs: client-guide §"Durable device cache (resume across
  reboots)", sync-strategies §"Durable cache (device resume)" + when-to-use
  row. Validation: client 62 tests green (was 58), full suite 504 green,
  repo-wide typecheck clean, lint clean, client + persistence dist rebuilt.

---
## [2026-08-17] client — G8: syncing client derives its watermark from a restored cache
- **Task**: G8 (P1) — Syncing client can't resume from a restored cache
  (watermark not derived) (docs/niche-gap-tasks.md)
- **Found by**: G8 implementation (packages/client, docs/sync-strategies.md)
- **Severity**: low
- **Status**: fixed
- **Description**: `SyncingClient` started with `lastAppliedTxInternal = null`
  even when `options.client` was a pre-populated mirror (e.g. restored from a
  durable IndexedDB/File cache after a reboot), so `handleOpen` always sent
  `afterTx: undefined` → full pull + client replacement — a device re-pulled
  the whole world instead of resuming incrementally. The constructor now
  derives the initial watermark from the provided client's ledger head
  (`ledger[ledger.length - 1][0]`, `null` for an empty ledger), so the first
  connect is an incremental `afterTx` catch-up against the real server
  frontier. Unchanged: empty clients (no ledger) still full-pull, and the
  divergence full-resync path (`needsFullResync`) still omits `afterTx`.
  Precedence with G9's `afterTime`: a restored ledger head wins over
  `afterTime` (matches the option's documented contract).
- **Resolution**: constructor watermark derivation in
  `packages/client/src/sync.ts` (+2 tests in sync.test.ts: a pre-populated
  client connects with `afterTx: 1`, receives only the delta, keeps the same
  client instance (no `onClientReplaced`), and merges tx 2; an empty provided
  client still sends a watermark-less `sync` and full-pulls via `snapshot`);
  docs/sync-strategies.md gained §2b "Resuming from a restored cache" and a
  when-to-use row. Validation: client 58 tests green (was 56), full suite 500
  green, repo-wide typecheck clean, lint at the pre-existing warning count,
  client dist rebuilt.

---
## [2026-08-17] core+server+client — G9: `afterTime` sync catch-up / `GET /facts?since=`
- **Task**: G9 (P2) — No "facts since `<timestamp>`" on the wire (`afterTime`)
  (docs/niche-gap-tasks.md; depends on G4's `txAtOrBefore`, done earlier
  today)
- **Found by**: G9 implementation (packages/core, packages/server,
  packages/client, docs/sync-strategies.md)
- **Severity**: low
- **Status**: fixed
- **Description**: Sync catch-up was only `afterTx` (an opaque tx id), but a
  device wants "new facts since 01-01-2026" — a wall-clock boundary. Added:
  - **`db.txBefore(timestamp)`** (core) — the strict-`<` counterpart of
    `txAtOrBefore`: the last committed tx with `timestamp < t` (0 when none),
    same binary search over the tx-ordered ledger. Facts committed **at/after**
    `t` are exactly the facts with `tx > txBefore(t)` — this is what makes the
    "at/after" boundary exact (a tx committed at exactly `t` is included,
    including duplicate-timestamp ledgers).
  - **`sync` message `afterTime`** (server `handleSync`): `{ type: 'sync', id,
    afterTime }` maps to a tx boundary via `db.txBefore` and reuses the
    existing chunked `facts` + `transactions` catch-up path; an explicit
    `afterTx` wins over `afterTime`.
  - **`GET /facts?since=<ms>`** (server `filteredFacts`) — the same
    "facts committed at/after `<ms>`" set over REST for one-shot pulls.
  - **Client `createSyncingClient({ afterTime })`** — seeds only the first
    connect's `sync` message with `afterTime`; once the catch-up applies, the
    watermark (streamed ledger head) takes over and reconnects use `afterTx`
    (an explicit `client` ledger head or a divergence full-resync also
    suppress it).
- **Resolution**: core `txBefore` (+2 tests: strict boundaries incl.
  duplicate timestamps); server `handleSync` afterTime + `filteredFacts`
  `since` (+2 tests: WS afterTime streams exactly txs 2,3 at/after 1500 and
  at the exact boundary 2000; REST since= happy path, exact boundary, before
  first commit, after last commit); client `SyncingClientOptions.afterTime` +
  `handleOpen` wiring (+1 test: first connect sends afterTime, reconnect
  sends afterTx from the watermark); docs/sync-strategies.md updated
  (protocol diagram, §3 afterTime catch-up, when-to-use table). Validation:
  core 239 tests green (was 237), server 28 (was 26), client 56 (was 55),
  full suite 498 green, repo-wide typecheck clean, lint clean on changed
  packages, dist rebuilt for core/server/client.

---
## [2026-08-17] core+client — G4: `db.txAtOrBefore` / `atTime` ("state as of <time>")
- **Task**: G4 (P2) — No timestamp → tx mapping for "state as of <time>" reads
  (docs/niche-gap-tasks.md)
- **Found by**: G4 implementation (packages/core, packages/client,
  packages/app-ops-desk, docs/client-guide.md)
- **Severity**: low
- **Status**: fixed
- **Description**: `at(tx)` is tx-id based while the ledger stores commit
  timestamps (`[tx, timestamp, metadata]`), so "stock as of last Tuesday"
  needed a manual mapping step. Added the clock-time counterpart:
  - **`db.txAtOrBefore(timestamp)`** — the last committed tx whose timestamp
    is `<= t`, or 0 when none qualifies. Implemented as a binary search over
    the tx-ordered ledger (commits stamp `Date.now()` in tx order, so
    timestamps are non-decreasing); documented that assumption.
  - **`db.atTime(timestamp)`** — `at(txAtOrBefore(t))`, the full time-travel
    view (entity / find / query / pull); an empty view before the first
    commit.
  - **`FatosClient` passthrough** — `txAtOrBefore(t)` and `atTime(t)`
    (client-shaped view: entity / find / query).
- **Resolution**: core: `txAtOrBefore` + `atTime` methods next to
  `at`/`atTransaction` (+3 tests in transact-query.test.ts using
  `restore()` for controlled timestamps, incl. a ledger-consistency property
  and an empty-ledger case). client: passthrough (+1 test with a restored
  db). app-ops-desk: TimeTravelPanel gained a `datetime-local` "State as of:"
  input whose Go button runs `client.txAtOrBefore(ms)` and drives the
  existing scrubber (the acceptance criterion). docs/client-guide.md:
  documented the mapping under "Time-travel reads". Validation: core 237
  tests green (was 234), client 55 green (was 54), full suite 493 green,
  repo-wide typecheck clean, lint clean on changed packages, ops-desk bundle
  builds.

---
## [2026-08-17] core+client — G2: `entity()` returns `ref()` values as plain ids by default
- **Task**: G2 (P1) — `entity()` returns `ref()` values as plain ids by default
  (docs/niche-gap-tasks.md; design/01 "default: plain id, for ergonomics and
  JSON compatibility")
- **Found by**: G2 implementation (packages/core, packages/client,
  packages/server, packages/schema-designer, packages/app-replay)
- **Severity**: low
- **Status**: fixed
- **Description**: `entity()` (and `find()`, and the `at(tx)` view) returned
  `ref()` values as symbol-branded objects, forcing every consumer to unwrap
  (Replay's `refTarget()`, DevTools graph, the schema-designer converter).
  Added the `refs` read option with default `'id'`: `entity(eid, tx?, {
  refs: 'id' | 'ref' })`, `find(criteria, { refs })` (FindOptions), and the
  `at(tx)` view (`entity(eid, options?)` / `find(criteria, { refs, tx })`).
  Behavior decisions recorded:
  - **`lookupRef` targets stay branded in both modes** (`ref(lookupRef(...))`
    and bare `lookupRef(...)` are never unwrapped — resolving them needs the
    unique-index lookup, which `pull` already does). Only `ref(number|string)`
    unwraps to the plain id.
  - **Cardinality-many ref attributes unwrap element-wise** (array of plain
    ids by default, array of branded refs with `{ refs: 'ref' }`).
  - **`pull()` is unchanged** (it already returns `{ id }` shapes and does its
    own lookupRef resolution).
  - **Server `GET /facts/:eid` reads with `{ refs: 'ref' }`** to preserve the
    B4.3 wire-tag contract (`$ref` tags must survive the endpoint so clients
    can round-trip losslessly); the plain-id default is an in-process
    ergonomic read shape only.
  - **Schema-designer `toSchemaDesignerDocumentFromFatosSnapshot` now resolves
    plain-id ref values** on ref-typed attributes (the default read shape) via
    `plainRefTargetId`, so relationship reconstruction still works when the
    snapshot's entity data carries plain ids instead of branded refs; the
    converter still passes entity attribute values through verbatim (per its
    documented limitation), so `entitiesData` now surfaces plain ids.
- **Resolution**: core: `EntityReadOptions` type, `FindOptions.refs`,
  `unwrapRefValue` helper, `entity`/`find`/`at` option plumbing (+8 tests in
  values.test.ts covering default plain id, `{ refs: 'ref' }`, many-valued
  element-wise unwrap, lookupRef stays branded, at-view passthrough, pull
  unchanged; 2 existing assertions updated in values.test.ts +
  transact-query.test.ts — the many-valued-ref fixture now reads plain ids
  directly). client: `entity`/`atTransaction` passthrough + `EntityReadOptions`
  re-export (+1 test). server: entity endpoint reads `{ refs: 'ref' }`.
  schema-designer: `plainRefTargetId` + test updated to the plain-id read
  shape. app-replay: dropped `refTarget()` — `readBoardAt`/`deleteNode` read
  plain ids directly (the acceptance-criteria win). Validation: core 234
  tests green (was 228), client 54 green (was 53), app-replay 6 green, server
  26 green, schema-designer 20 green, all other workspaces' tests green (489
  total incl. the pre-existing e2e collection quirk), repo-wide typecheck
  clean, lint clean on changed packages.

---
## [2026-08-14] devtools — Phase 6 time travel UI implemented
- **Task**: Phase 6: Time travel UI (design/04 P4 "replay a tx range against a snapshot")
- **Found by**: Phase 6 implementation (packages/devtools, packages/chrome-extension)
- **Severity**: low
- **Status**: fixed
- **Description**: Added a Time Travel tab to the DevTools panel. New pure
  helpers in devtools transforms: `factsAtOrBefore`,
  `transactionsAtOrBefore`, `buildScopedSnapshot` (a point-in-time snapshot
  that keeps the restore invariants, so `db.restore` accepts it).
  `DevtoolsPanelController` gained `setTimeTravelTx(tx | null)`, which rebuilds
  the client from a scoped snapshot — Facts/Entities/Query tabs all reflect the
  pinned transaction — plus `getTimeTravelDiff(tx)` (the step diff against the
  **full** log, `db.diff(tx-1, tx)`). Notable decisions/limitations:
  - **The full snapshot db is kept separate from the scoped client db.** Diffs
    always read the full log, so the Diff tab and the time-travel step diff
    still see facts after the pinned tx even while the client is scoped.
  - **`setTimeTravelTx` rebuilds the client via `db.restore`** (O(n) per pin)
    instead of wrapping reads in `db.at(tx)`; this keeps every tab reading the
    same scoped client with no per-read tx plumbing. Fine for inspector-size
    datasets; a very large snapshot would make slider drags feel heavy.
  - **Rebuilding on every slider `input` event is intentional** (live scrub);
    the number input commits on `change` instead.
  - `getTimeTravelDiff` stores without notifying (the tab reads it after
    `setTimeTravelTx` notified), avoiding a render→diff→notify loop.
- **Resolution**: devtools transforms.ts (+3 helpers), controller.ts
  (time-travel state + methods + `getSchemas`), exports; chrome-extension
  panel-ui.ts Time Travel tab (slider + number input + Latest + step diff) and
  panel.html tab button. Tests: transforms.test.ts (+2 blocks),
  controller.test.ts (+5). Validation: devtools build + typecheck + 74 tests
  green; chrome-extension build + typecheck + 2 tests green.

## [2026-08-14] devtools — Phase 6 graph visualization implemented
- **Task**: Phase 6: Graph visualization
- **Found by**: Phase 6 implementation (packages/devtools, packages/chrome-extension)
- **Severity**: low
- **Status**: fixed
- **Description**: Added a Graph tab. New pure module `devtools/src/graph.ts`:
  `buildGraphModel(facts, schemas?)` builds nodes (entities with facts; schema
  entities with negative eids are skipped) and edges from ref-typed attribute
  facts — branded `ref()` values whose target is a known entity id, or a plain
  entity-id value on a ref schema attribute (`valueType: 'ref'` / `ref: true`).
  Edges are labeled with the attribute name, deduplicated by (from, attribute,
  to), and retracted refs are ignored. `layoutGraph` is a deterministic circle
  layout (no force simulation, no new dependency); `renderGraphSvg` (render.ts)
  draws straight-line edges + node circles as inline SVG, document-guarded.
  Notable limitations:
  - **Lookup-ref targets are dropped** (resolving them needs a database to find
    the unique-attribute holder); only direct id refs become edges.
  - **Ref targets without any facts are dropped** (no node to attach to).
  - The graph reflects the time-travel scope when a tx is pinned (consistent
    with the other tabs).
- **Resolution**: graph.ts + graph.test.ts (8 tests), render.ts
  `renderGraphSvg` (+1 render test), exports; chrome-extension panel-ui.ts
  Graph tab + panel.html button. Validation: devtools build + typecheck + 74
  tests green; chrome-extension build + typecheck + 2 tests green.

## [2026-08-14] client + server — Phase 6 client-server sync strategies implemented
- **Task**: Phase 6: Client-server sync strategies (docs/03 afterTx catch-up primitive)
- **Found by**: Phase 6 implementation (packages/client, packages/server)
- **Severity**: low
- **Status**: fixed
- **Description**: Implemented `createSyncingClient` (new `packages/client/src/
  sync.ts`, exported from @fatos/client) and a server-side `sync` WS message
  (the full-facts counterpart of the spec-scoped `subscribe` registry):
  `{ type: 'sync', id, afterTx? }` → `synced` + `facts` (tx > afterTx) +
  `transactions` (tx > afterTx) + live `sync-event` frames per committed
  transaction. The live subscription is registered before the catch-up is
  computed, and the whole exchange is synchronous, so no commit can fall into
  the catch-up/live gap. Client strategies: full snapshot pull (first connect,
  `db.restore`, client instance replaced) vs. `afterTx` incremental catch-up
  (reconnect, per-tx `client.transact` on the same instance, watermark advanced
  only on success) with a full-pull fallback after an incremental apply
  failure. Documented in docs/sync-strategies.md. Notable decisions and
  deviations:
  - **Incremental replay converts schema facts back into schema declarations**
    (`factsToTransactionEntries`): replaying stored schema facts through
    `transact` is provably wrong (negative eids would be remapped as tempids —
    the same reason core has `restore()`; see the Phase 5 issue below). The
    conversion groups negative-eid `db/*` facts per schema entity and emits
    `SchemaDeclaration`s first, then data mutations.
  - **`restore` cannot be used for incremental catch-up** (empty-db only), so
    the watermark must always track *server* tx numbers (local tx numbers after
    `transact` replay differ; they are never used for sync bookkeeping).
  - **Full-pull fallback swaps the client instance**; apps must re-bind to
    `syncingClient.client` (`onClientReplaced` fires). A divergence escape
    hatch, not a normal path.
  - **Server protocol is an additive message type** (`sync`); the existing
    spec-scoped `subscribe`/`afterTx` behavior and the raw fan-out are
    untouched. `unsubscribe` now also disposes sync subscriptions; socket close
    disposes both registries.
  - **Transaction metadata is not value-tagged** on the wire (matches the
    existing `/transactions` REST endpoint).
  - **Text frames only**; non-string message data is ignored.
- **Resolution**: client sync.ts (+15 tests incl. fake-socket flows:
  full sync, live apply, afterTx reconnect, malformed frames, schema restore,
  fallback rebuild), server `handleSync` + registries (+2 WS tests).
  Validation: client build + typecheck + 33 tests green; server typecheck + 13
  tests green; docs/sync-strategies.md added; PLAN.md Phase 6 ticked.



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
- **Status**: fixed
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
- **Resolution**: core `live(fn)` and client `live(fn)` now evaluate the
  selector with the database/client as the first argument
  (`db.live(db => db.find(...))`, design/03). Overload types updated to
  `live<T>(fn: (db: FactDatabase) => T)` / `live<T>(fn: (client: FatosClient) => T)`;
  the core access-tracking form evaluates `fn(this)` and the client form
  evaluates `fn(client)` (delegating the tracked reads to the underlying db).
  Non-breaking: existing no-arg selectors ignore the extra argument. The React
  hook is unchanged (`client.live(() => selector(client))` — behavior
  identical; comment updated). New tests assert the selector receives the
  db/client on first evaluation and on re-runs after relevant writes (core
  live.test.ts +1, client index.test.ts +1). Validation: core and client
  build/typecheck/tests green (core 214, client 34); react, server, devtools,
  examples typecheck green.

## [2026-08-14] react — tests use react-test-renderer (deprecated) pinned to React 18 types
- **Task**: P2 React half (tests, packages/react only)
- **Found by**: P2 React implementation (packages/react)
- **Severity**: low
- **Status**: fixed (documented decision — deferred, see Resolution)
- **Description**: The vitest environment is `node` (root vitest.config) with no
  jsdom/happy-dom and no DOM shim in the repo, and `react-dom/client` needs a
  DOM. The P2 hook tests therefore use `react-test-renderer` (new devDependency,
  works without a DOM). React docs mark react-test-renderer deprecated (React
  19 removed it), and `@types/react-test-renderer` resolves to 19.x by default,
  which is incompatible with the React 18.3 types used here — it had to be
  pinned to `18.3.1`. When the repo upgrades to React 19, swap the tests to
  `react-dom/client` + a DOM environment or @testing-library.
- **Resolution**: devDeps added to packages/react only (`react-test-renderer@^18.3.1`,
  `@types/react-test-renderer@^18.3.1`); package-lock.json updated. Decision
  (2026-08-14 follow-up, documented only — no code change): the repo is on
  React 18, where react-test-renderer is deprecated but functional and the
  18.x-pinned types are the correct pairing; the deprecation is **deferred
  until a React 19 upgrade**. No action is warranted before that upgrade, at
  which point the tests move to `react-dom/client` + a DOM environment or
  @testing-library as noted above.

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
- **Status**: fixed
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
- **Resolution**: `createLiveQueryResult` now wraps the async generator in an
  explicit iterator whose `return()`/`throw()` call `dispose()` first —
  resolving any pending idle `resolveNext` and flipping `disposed` so the
  generator's loop exits on wake — then delegate to the real generator so its
  `finally` runs and the return/throw completes. Verified with a standalone
  V8 repro: `return()`/`throw()` issued while idle-pending settle in 0 ms
  (previously hung indefinitely; the generator's `finally` never ran). New
  test in live.test.ts: start liveQuery, get the initial yield, leave a
  `next()` in flight (generator idle-pending), `Promise.race` an
  `iterator.return()` against a 1 s timeout and assert it settles 'returned';
  the abandoned `next()` and later reads complete as done. Validation: core
  build/typecheck green; live.test.ts 19/19; full core suite 214 tests green.

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

## [2026-08-14] devtools + schema-designer + persistence — Phase 6 export/import & Phase 7 round-trip fixtures
- **Task**: Phase 6: Export/import functionality; Phase 7: Integrate file
  import/export UI in DevTools panel; Add round-trip import/export + adapter
  test fixtures
- **Found by**: Phase 6/7 implementation (packages/devtools, packages/chrome-extension,
  packages/schema-designer, packages/persistence)
- **Severity**: low
- **Status**: fixed (with documented deviations below)
- **Description**: Landed devtools snapshot export/import
  (`serializeSnapshot`/`deserializeSnapshot` pure + `SnapshotFormatError`,
  `downloadSnapshot`/`pickSnapshotFile` DOM-guarded and injectable via a
  `FileIo` interface), controller `exportSnapshot()`/`importSnapshot(text)`,
  Export/Import buttons in the chrome-extension panel, a schema-designer
  round-trip fixture (`makeBlogDocument` → `toFatosTransactionEntries` → core
  db → `FatosJsonSnapshot` → `toSchemaDesignerDocumentFromFatosSnapshot`) with
  tests asserting schema attributes + data survive for string/date/bigint/
  many/ref values, and a persistence serialization unit test for
  Date/bigint/ref/array/metadata wire round-trips. Deviations and limitations:
  - **`importSnapshot` returns `boolean`** (not `void` as the task sketch
    suggested) so callers can distinguish success/failure and tests can assert
    state preservation; the panel uses the return value + `getLastError()`.
  - **DevTools export is the plain wire snapshot shape**
    `{ facts, transactions, capturedAt?, url? }` (no `version` field);
    `deserializeSnapshot` additionally accepts the persistence
    `{ version: 1, ... }` envelope so FileAdapter exports import into the
    panel. Values are tagged with the core wire tags (`$date`/`$bigint`/
    `$ref`/`$lookupRef`), so Date/bigint/ref values survive losslessly.
  - **`toSchemaDesignerDocumentFromFatosSnapshot` now reconstructs
    relationships** from ref schema declarations (`valueType: 'ref'` or
    `db/ref` true): the target entity is resolved from stored ref values in
    the entity data (branded `ref(id)` / `ref(lookupRef(...))` and wire
    `$ref` forms), with a ref-name heuristic fallback (`authorId` -> entity
    `author`). Exactness limits: the snapshot does not carry user-authored
    relationship names or the source-side multiplicity, so the name is
    synthesized as `<source> -> <target>` and `fromCardinality` defaults to
    `'one'`; `toCardinality` is exact (it equals the ref attribute's
    cardinality, which is how `toFatosTransactionEntries` encodes it);
    self-references are skipped to match the designer model. The ref
    attribute itself still also survives on the source entity.
  - **The converter passes entity attribute values through verbatim**, so a
    wire-form snapshot (e.g. a devtools export) imported into the schema
    designer would surface `{ $date }`/`{ $bigint }`/`{ $ref }` objects in
    `entitiesData` instead of engine Date/bigint/ref values. The round-trip
    fixture goes through `db.find({})` (engine values) and stays green; a
    follow-up could deserialize values in the converter.
  - **Imported attribute ids are the converter's stable lowercased ids** (e.g.
    `post:authorid` from `authorId`), so a re-imported document's attribute ids
    may differ in casing from the source document's.
- **Resolution**: devtools: new export-import.ts (+13 tests: 10 in
  export-import.test.ts, 3 in controller.test.ts), controller + index exports;
  chrome-extension: panel-ui.ts export/import wiring + panel.html buttons;
  schema-designer: fixtures.ts + 1 round-trip test (19 total);
  persistence: serialization.test.ts (+3, 32 total). Validation: devtools
  build + typecheck + 55 tests green; chrome-extension build + typecheck + 2
  tests green; schema-designer typecheck + 19 tests green; persistence
  typecheck + 32 tests green; core 212 tests green (unchanged). Follow-up
  (this task): the converter now reconstructs relationships (targets resolved
  from data/lookupRef/wire `$ref` with a ref-name heuristic fallback), the
  round-trip fixture grew to two relationships (one-to-many + a many-valued
  ref), and tests assert reference attributes, synthesized names, exact
  `toCardinality`, and defaulted `fromCardinality`; schema-designer build +
  typecheck + 20 tests green.

## [2026-08-14] client + devtools — unsafe destructuring of `any[]` in tuple type guards (eslint)
- **Task**: Fix 4 `@typescript-eslint/no-unsafe-assignment` errors
- **Found by**: eslint run over packages/client and packages/devtools
- **Severity**: low
- **Status**: fixed
- **Description**: `isFactTuple` / `isTransactionTuple` type guards in
  packages/client/src/sync.ts and packages/devtools/src/snapshot.ts (duplicated
  helpers) destructured `value` directly after `Array.isArray`, which narrows
  `unknown` to `any[]` and made every destructured element `any` — flagged as
  unsafe assignment. `Array.isArray` itself narrows to `any[]` (lib.es5
  `isArray(arg: any): arg is any[]`), so a cast to `unknown[]` before
  destructuring restores `unknown` element typing; the existing element checks
  (`isEntityId`, `typeof === 'string'`, `Number.isInteger`, op/`metadata`
  checks) then narrow as before. No behavior change: the same guards, checks,
  and return values, and the two files' guard style is identical.
- **Resolution**: `const [...] = value as unknown[];` at sync.ts:131/146 and
  snapshot.ts:52/67. Validation: eslint exits 0 in both packages (client still
  has 1 pre-existing `explicit-module-boundary-types` warning in index.ts:262,
  unrelated), `tsc --noEmit` clean, client 34 tests + devtools 74 tests green.
---
## [2026-08-15] server+client — B4.3 raw WS event fan-out now wire-safe
- **Task**: B4.3 — serialize the raw WS event fan-out values
- **Found by**: server performance review (docs/performance-bottlenecks.md)
- **Severity**: high (crash / silent corruption on Date/bigint/ref writes with connected clients)
- **Status**: fixed
- **Description**: `FatosServer.transact()` emitted raw engine facts into the
  `fact:added` / `transaction:committed` fan-out, and `broadcastWebSocketEvent`
  / the SSE endpoint / the HTTP `/transact` responses `JSON.stringify`'d them
  directly: bigint values threw `TypeError`, `ref()` values (Symbol-keyed
  frozen objects) silently collapsed to `{}`, Dates lost their `$date` tag.
- **Resolution**: `serializeServerEventForWire` / `serializeTransactionRecord` /
  `serializeMetadata` / `serializeEntityState` in `packages/server/src/index.ts`
  tag values through the design/03 wire tags everywhere the raw event or
  transaction/entity data leaves the server — WS raw fan-out, SSE, HTTP
  `/transact`, `GET /transactions`, `GET /facts/:id` — and the sync
  `sync-event` / `transactions` frames use the same serializers. The syncing
  client revives tagged metadata (`deserializeMetadata`) before storing it.
  Validation: server 21 tests green (added WS Date/bigint/ref + REST endpoint
  tests), client sync tests green, repo suite 458 tests green.

## [2026-08-15] server — B4.5 raw broadcast scoped to bare (audit-stream) clients
- **Task**: B4.5 — per-subscription broadcast filtering
- **Found by**: server performance review
- **Severity**: medium (fan-out amplification on many subscribed connections)
- **Status**: fixed
- **Description**: every `transaction:committed` / `fact:added` event was sent
  to every connected WebSocket client even when only a subset held `subscribe`
  or `sync` registrations — those clients were re-sent the same data they
  already receive as tailored frames (`facts` / `sync-event`).
- **Resolution**: `broadcastWebSocketEvent` now reaches only *bare* clients —
  those holding no entry in the `clientSubscriptions` or `syncSubscriptions`
  registry (`isRawStreamRecipient` in `packages/server/src/index.ts`). This
  preserves the design/03 raw fan-out for DevTools/audit streams (bare
  connections, as the `packages/examples` server/full-stack demos use) while
  skipping the redundant broadcast for subscribed clients. Per-spec filtering
  (only facts matching a client's QuerySpecs) remains a scoped follow-up.
  Validation: server tests green (three-client test: bare receives raw,
  subscribed clients do not, unsubscribed client re-joins the stream);
  examples tests green; full repo suite green.

## [2026-08-15] server+client — B4.1 state-snapshot sync for fresh clients
- **Task**: B4.1 — bound fresh-client sync to active state, not history
- **Found by**: server performance review
- **Severity**: medium (fresh clients pulled the whole fact log, O(history))
- **Status**: fixed
- **Description**: a brand-new syncing client full-pulled the entire append-only
  fact log (chunked per frame, but O(total history) bytes).
- **Resolution**: `handleSync` serves fresh pulls (no `afterTx`) a `snapshot`
  frame: the minimal current-state fact set (`currentStateFacts` — only the
  latest asserted `'add'` fact per `(eid, attribute, value)` triple) plus the
  full ledger. The client (`packages/client/src/sync.ts` `applySnapshot`)
  rebuilds via `db.restore()`, preserving schema facts verbatim, and sets its
  watermark to the ledger head so a later reconnect catches up incrementally.
  The chunked full-log pull remains the fallback; the `afterTx` path is
  unchanged. Validation: server + client sync tests green; full repo suite 458
  tests green. Docs: `docs/sync-strategies.md` updated for the `snapshot` frame.

---
## [2026-08-15] persistence — B4.2 append modes for Postgres/Mongo/IndexedDB
- **Task**: B4.2 — `StorageAdapter.append` fast paths for the remaining adapters
- **Found by**: server performance review
- **Severity**: medium (O(total facts) snapshot save per tx for these backends)
- **Status**: fixed
- **Description**: Postgres / Mongo / IndexedDB adapters fell back to the full
  snapshot `save()` per transaction while File/Memory used the O(transaction)
  `append()` fast path.
- **Resolution**: all three adapters now implement `append(transaction, facts)`
  mirroring `FileAdapter`'s snapshot + append-log pattern
  (`packages/persistence/src/adapters/{postgres,mongodb,indexeddb}.ts`):
  Postgres gains a second `fatos_log` table (configurable via `options.logTable`,
  `INSERT … ON CONFLICT (id) DO NOTHING`); Mongo gains per-transaction log
  documents and exposes `append` only when the injected collection supports
  insertion (otherwise it omits it and the server falls back to `save()`);
  IndexedDB gains a second object store keyed by tx. `load()` merges the
  snapshot with log entries newer than the snapshot's last tx (no double-replay),
  and `save()` remains the checkpoint that truncates the log. Validation:
  persistence tests green (per-adapter append/replay/checkpoint tests), server
  tests green. Open limitation: the IndexedDB runtime shape is still verified
  only against the test fake — a real-browser smoke test is a follow-up.

## [2026-08-15] client — B4.4 fine-grained reactive observers
- **Task**: B4.4 — observe* only wakes on relevant changes
- **Found by**: server performance review (client reactivity layer)
- **Severity**: medium (every-write notifications for spec-scoped observers)
- **Status**: fixed
- **Description**: `@fatos/client`'s `observe` / `observeQuery` / `observeEntity`
  attached a `transaction:committed` listener and re-ran their query on every
  write, deduping by `stableKey`; core's dependency-tracked live handles already
  prune by relevance.
- **Resolution**: the three observers are now built on `this.db.live(...)`
  (`observe` → `db.live(criteria)`, `observeQuery` → `db.live(spec)`,
  `observeEntity` → access-tracking `db.live(() => this.entity(eid))`), keeping
  the synchronous initial callback and `Unsubscribe` contract. `observeTransactions`
  stays on the every-write listener (ledger reads are not live-tracked; it
  already dedupes). Validation: client tests green (added "does not fire on
  unrelated transactions" tests); full repo suite 458 tests green.

## [2026-08-15] repo — CI fix (build + vitest run), LICENSE, gap-analysis refresh
- **Task**: repo hygiene — CI workflow, MIT license, stale gap-analysis doc
- **Found by**: coordinator review (2026-08-15)
- **Severity**: low
- **Status**: fixed
- **Description**: `.github/workflows/ci.yml` ran `npm test` (vitest watch mode
  — hangs in CI) without building; `dist/` is gitignored and cross-package
  imports resolve through built `dist/`, so a fresh checkout had no dist to
  import. README's License was "To be determined". `docs/gap-analysis-query-schema-rules.md`
  still marked already-implemented features (find operators, orderBy/limit/
  offset/select, pull, at/diff, db/unique, db/ref, value types) as "designed,
  not yet built".
- **Resolution**: CI now runs `npm ci` → `npm run build` → `npx vitest run` →
  `npm run types`. Added `LICENSE` (MIT, "Fatos contributors") and pointed
  README at it. Refreshed the gap-analysis doc: implemented rows verified
  against `packages/core/src/index.ts` and marked ✅ (2026-08); still-missing
  items (`retractEntity`, ref existence enforcement, Datalog find shapes, `:in`,
  aggregates, rules) left as-is.


## [2026-08-16] client — G1: client `find` / `at(tx).find` lack core options (orderBy/limit/offset/select)
- **Task**: G1 in docs/niche-gap-tasks.md — expose `FindOptions` on `FatosClient.find` + `atTransaction(tx).find`, and a `useQuery(criteria, options?)` react overload
- **Found by**: niche-validation apps (app-liveboard sorts in JS; app-ops-desk ships a sortBy helper)
- **Severity**: medium
- **Status**: fixed
- **Description**: Core `FactDatabase.find` supports `{ orderBy, limit, offset, select }`; the client wrapper only accepts a tx number, so demo apps reimplement ordering.
- **Resolution**: `FatosClient.find(criteria, options?: number | FindOptions)` now delegates straight to core; `atTransaction(tx).find(criteria, options?)` merges `{ ...options, tx }` so time-travel reads keep their scope alongside ordering/paging/select. `@fatos/client` re-exports `FindOptions`/`OrderBy`/`OrderDirection`. `@fatos/react` gained `useQuery(criteria, options?)`, built on the access-tracking selector form `client.live(() => client.find(criteria, options))` so orderBy/select reads stay AEVT-tracked (a sort-key write still wakes the handle). LiveBoard dropped its JS `byOrder` sort for `useQuery({ 'card/column' }, { orderBy: ['card/order', 'asc'] })`. Docs: client-guide.md + react-guide.md updated (also fixed a stale `.at(-1)?.id` tuple-access example). Validation: client +2 tests, react +1 test; client/react builds, typechecks, and tests green; app-liveboard typecheck green.

## [2026-08-16] core — G2: `entity()` returns branded ref objects; design/01 promises plain ids by default
- **Task**: G2 in docs/niche-gap-tasks.md — `entity(eid, tx?, { refs: 'id' | 'ref' })` defaulting to plain-id unwrapping
- **Found by**: niche-validation apps (app-replay `refTarget()` unwraps edge refs; devtools graph has the same workaround)
- **Severity**: medium
- **Status**: open
- **Description**: `ref()` values are returned verbatim from entity state; consumers must unwrap via `REF_BRAND`.
- **Resolution**: —

## [2026-08-16] client — G3: syncing client is read-only; writes need a separate REST helper
- **Task**: G3 in docs/niche-gap-tasks.md — write methods (`transact`/`add`/`retract`) on `SyncingClient` forwarded over REST to the derived HTTP base
- **Found by**: niche-validation apps (app-ops-desk and app-liveboard each duplicate src/api.ts `postTransact`)
- **Severity**: medium
- **Status**: fixed
- **Description**: `createSyncingClient` mirrors the server but cannot write; every write is a REST hop the mirror then replays.
- **Resolution**: client sync.ts gained `transact`/`add`/`retract` write-through
  on `SyncingClient`: HTTP base derived from the ws url (`ws://host/ws` →
  `http://host`, wss → https), injectable `fetch` option (tests inject a fake),
  entry values wire-tagged via core `serializeValue`, response revived
  (facts + transaction incl. metadata), failures surfaced both by rejection and
  `onError`. Demo apps app-ops-desk and app-liveboard dropped `src/api.ts` and
  write via `sync.transact` (mirror replays the broadcast). Docs:
  sync-strategies.md "Writes" section, client-guide.md syncing-client section,
  both app READMEs. Validation: client build + typecheck + lint green, 51 tests
  pass (+7 write-through tests in sync.test.ts); both demo apps typecheck and
  build green.

## [2026-08-16] core — G4: no timestamp→tx mapping for "state as of <time>"
- **Task**: G4 in docs/niche-gap-tasks.md — `db.txAtOrBefore(timestamp)` / `db.atTime(timestamp)`
- **Found by**: niche-validation apps (app-ops-desk README: "stock as of last Tuesday")
- **Severity**: low
- **Status**: open
- **Description**: `at(tx)` is tx-id based; the ledger stores timestamps but no helper maps a wall-clock time to the last tx at-or-before it.
- **Resolution**: —

## [2026-08-16] react — G5: no first-class as-of read hook (scrub re-renders coarsely)
- **Task**: G5 in docs/niche-gap-tasks.md — `useQuery(criteria, { asOf })` / `useEntity(eid, { asOf })`
- **Found by**: niche-validation apps (app-ops-desk `TimeTravelPanel` uses a coarse subscribe+re-read tick)
- **Severity**: low
- **Status**: open
- **Description**: React hooks model only current state; time-travel UIs fall back to manual re-reads.
- **Resolution**: —

## [2026-08-16] core — G6: convenience for "facts committed by tx N"
- **Task**: G6 in docs/niche-gap-tasks.md — `db.transactionFacts(tx)` / `db.transaction(tx)`
- **Found by**: niche-validation apps (app-replay derives step facts from `db.diff(headTx-1, headTx)`)
- **Severity**: low
- **Status**: open
- **Description**: No direct API answers "what did transaction N commit"; consumers reconstruct it from diff.
- **Resolution**: —

## [2026-08-16] examples — G7: demo follow-ups (reference-app guide, agent-session recorder)
- **Task**: G7 in docs/niche-gap-tasks.md — extract the Ops Desk reference flow; build an AI-agent session recorder variant of app-replay
- **Found by**: niche-validation review (docs/niche-validation.md follow-ups)
- **Severity**: low
- **Status**: open
- **Description**: Product-shaped follow-ups beyond the library API gaps.
- **Resolution**: —


## [2026-08-16] client — G8: syncing client can't resume from a restored cache (watermark not derived)
- **Task**: G8 in docs/niche-gap-tasks.md — derive the initial `afterTx` watermark from `options.client`'s ledger head in `SyncingClient`
- **Found by**: device/edge sync re-analysis (2026-08-16) — a device with a durable local cache must resume incrementally, not full-pull
- **Severity**: medium
- **Status**: open
- **Description**: `createSyncingClient({ client })` ignores the pre-populated mirror's ledger for the watermark (`lastAppliedTxInternal` stays null), so reconnect always does a full pull + client replacement.
- **Resolution**: —

## [2026-08-16] core+server — G9: no "facts since <timestamp>" on the wire (afterTime)
- **Task**: G9 in docs/niche-gap-tasks.md — `db.txAtOrBefore(timestamp)` + `afterTime` on the sync message / `GET /facts?since=`
- **Found by**: device/edge sync re-analysis (2026-08-16) — "new facts since 01-01-2026" is the natural device catch-up query
- **Severity**: medium
- **Status**: open
- **Description**: Catch-up is only `afterTx` (opaque tx id); no timestamp→tx mapping and no `afterTime` parameter. Depends on G4.
- **Resolution**: —

## [2026-08-16] client — G10: persisting the syncing mirror (durable local cache)
- **Task**: G10 in docs/niche-gap-tasks.md — optional `adapter` on `createSyncingClient` that appends applied transactions and restores on start
- **Found by**: device/edge sync re-analysis (2026-08-16) — the mirror must survive reboots
- **Severity**: medium
- **Status**: open
- **Description**: No built-in persistence of the mirror; applied sync-events must be appended to an adapter manually. Depends on G8.
- **Resolution**: —

