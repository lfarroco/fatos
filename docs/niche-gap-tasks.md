# Task List — Fixing the Gaps the Demo Apps Surfaced

> Source: the three niche-validation apps (`packages/app-ops-desk`,
> `packages/app-replay`, `packages/app-liveboard`) built 2026-08-16, plus the
> fact-log sync re-analysis (same date, `docs/niche-validation.md`). Each gap
> was hit while writing real app code against the current API — not inferred
> from the design docs. Verdict READMEs and the analysis live in
> `docs/niche-validation.md`.
>
> Work convention (per AGENTS.md): keep changes package-scoped, preserve
> `strict: true` / type-aware lint, add vitest tests with behavior changes, and
> rebuild a package's `dist/` before type-checking or testing its dependents.

Priority legend: **P1** = removes app-level friction the demos hit directly ·
**P2** = rounds out a temporal story the demos wanted · **P3** = polish /
convenience.

---

## G1 — [P1] Client `find` (and `at(tx).find`) don't expose core options

**Where it showed up:** every demo app. LiveBoard sorts cards in JS
(`app-liveboard/src/app.tsx` `byOrder`), Ops Desk ships a `sortBy` helper —
because `FatosClient.find(criteria, tx?)` accepts only a tx number while core
`FactDatabase.find(criteria, options?: number | FindOptions)` supports
`orderBy` / `limit` / `offset` / `select`.

**Location:** `packages/client/src/index.ts` — `find`, `atTransaction` view.

**Work:**
- Add a `find(criteria, options?: number | FindOptions)` overload to
  `FatosClient` that delegates to the core db (pass both `tx` and options).
- Surface the same options on the client's `atTransaction(tx)` / `at(tx)` view.
- Add a `@fatos/react` `useQuery(criteria, options?)` overload so ordered
  queries work without a selector.

**Acceptance:** client test: `client.find(criteria, { orderBy, limit, offset, select })`
returns ordered/paged/picked entities; react test for `useQuery(criteria, { orderBy })`.
Refactor LiveBoard to drop its JS sort.

---

## G2 — [P1] `entity()` returns `ref()` values as branded objects, not plain ids

**Where it showed up:** Replay (`board.ts` `refTarget()` unwraps every edge's
`edge/from` / `edge/to`), and it's the same friction the DevTools graph code
works around.

**Location:** `packages/core/src/index.ts` — `entity()` (~line 1866) stores the
value verbatim; `pull()` already unwraps via `pullRefTarget`.

**Work:**
- Add a read option to `entity()`: `entity(eid, tx?, { refs: 'id' | 'ref' })`
  with **default `'id'`** (as promised by design/01: "default: plain id, for
  ergonomics and JSON compatibility"). `'id'` unwraps `ref(number|string)` to
  the plain eid; `'ref'` keeps the branded value.
- Apply consistently to `find()` results and the `at(tx)` view.
- Decide + document the behavior for `lookupRef` targets (suggested: keep as
  the branded `lookupRef` object — unwrapping needs the unique-index lookup).
- Consider the same option on the client `entity` / `atTransaction`.

**Acceptance:** `values.test.ts` / new test — a `db/ref` attribute reads back as
a plain entity id by default and as a branded ref with `{ refs: 'ref' }`;
`pull` behavior unchanged. Replay can drop `refTarget()` for committed eids.

---

## G3 — [P1] Syncing client is read-only: writes need a separate REST helper

**Where it showed up:** Ops Desk and LiveBoard each carry a near-identical
`src/api.ts` `postTransact` because `createSyncingClient` mirrors the server
but cannot write to it — every write is a REST hop the mirror then replays.

**Location:** `packages/client/src/sync.ts` (`SyncingClient`).

**Work:**
- Add write methods to `SyncingClient`: `transact(entries, metadata?)`,
  `add(...)`, `retract(...)`, derived from the ws URL's HTTP base
  (`ws://host:port/ws` → `http://host:port`) and `POST /transact` (or
  `/facts`).
- Use the injected-socket pattern for tests (already present) plus an
  injectable `fetch` so the write path is testable without a network.
- Return the server response (facts + transaction); surface write errors via
  `onError`.

**Acceptance:** `sync.test.ts` — `SyncingClient.transact` POSTs the right body
to the derived URL and, when the server's broadcast arrives, the mirror applies
it. Refactor both demo apps to drop their `api.ts` and write through the sync
client. Update `docs/client-guide.md` (write path is no longer "mirror +
separate REST helper").

---

## G4 — [P2] No timestamp → tx mapping for "state as of <time>" reads

**Where it showed up:** Ops Desk README — "stock as of last Tuesday" needs an
extra mapping step because `at(tx)` is tx-id based while the ledger stores
timestamps (`[tx, timestamp, metadata]`).

**Location:** `packages/core/src/index.ts` (transactions already carry
timestamps; `at(tx)`/`diff` exist).

**Work:**
- Add `db.txAtOrBefore(timestamp: number): number` — the last committed tx
  with `timestamp <= t` (0 when none) — and/or `db.atTime(timestamp)` returning
  the `at(tx)` view for that tx.
- Passthrough on `FatosClient`.

**Acceptance:** core test with controlled timestamps (assert against
`getTransactions()`); Ops Desk adds an "as of <time>" input that drives the
existing scrubber.

---

## G5 — [P2] No first-class React as-of read (scrub re-renders coarsely)

**Where it showed up:** Ops Desk `TimeTravelPanel` re-renders via a coarse
`useClientTick` (subscribe + re-read) because the hooks only model *current*
state.

**Location:** `packages/react/src/index.ts`.

**Work:**
- Add an as-of hook, e.g. `useQuery(criteria, { asOf: tx })` /
  `useEntity(eid, { asOf: tx })`, backed by `client.live` on the transaction
  list + a per-tx read (re-evaluate when the scrub tx or the ledger changes).
- Document the coarse pattern as the fallback for custom reads.

**Acceptance:** react test — the hook re-renders when `tx` changes and when new
transactions commit, and does not re-render on unrelated writes below the
scrub point. Refactor `TimeTravelPanel` to use it.

---

## G6 — [P3] Convenience for "facts committed by tx N" / tx metadata

**Where it showed up:** Replay's undo wrapper calls
`db.diff(headTx(db) - 1, headTx(db))` to derive a step's facts; both audit
panels format `TransactionRecord` metadata by hand.

**Location:** `packages/core/src/index.ts`.

**Work:**
- Add `db.transactionFacts(tx: number): Fact[]` (facts with `f[3] === tx`)
  and/or `db.transaction(tx)` returning the record.
- Client passthrough.

**Acceptance:** core test; Replay's step-diff panel uses it.

---

## G7 — [P2] Demo follow-ups (product-shaped)

- **Reference-app guide:** extract the Ops Desk pattern (seed → REST writes
  with actor metadata → live dashboard → `at(tx)` reporting → restart
  recovery) into a documented reference flow, so new users have a proven
  template.
- **AI-agent session recorder:** build a variant of Replay that records an
  agent's tool calls/state transitions as facts and replays them on a timeline
  — the most current, shareable demo of the temporal niche.
- **FieldSync app:** build the planned device/edge state sync demo per
  [docs/app-fieldsync-design.md](../docs/app-fieldsync-design.md) — durable
  IndexedDB cache, Reboot resume, "facts since `<date>`" catch-up, HQ relay
  dashboard. Do it alongside G8/G10 (see §12 of the design doc).


## G8 — [P1] Syncing client can't resume from a restored cache (watermark not derived)

**Where it showed up:** device/edge sync re-analysis (2026-08-16) — a device
with a durable local cache (IndexedDB / File) that reboots must resume
incrementally, not re-pull the whole world.

**Location:** `packages/client/src/sync.ts` — `SyncingClient` sets
`lastAppliedTxInternal = null` even when `options.client` is a pre-populated
mirror, so `handleOpen` always sends `afterTx: undefined` → full pull + client
replacement.

**Work:**
- When `options.client` is provided, derive the initial watermark from its
  ledger head (`lastAppliedTxInternal = lastAppliedTx(client.getTransactions())`).
- Keep the full-pull fallback for empty clients and divergence (unchanged).

**Acceptance:** `sync.test.ts` — a client pre-populated with a ledger and
connected to a server with more txs receives only the delta (no `snapshot`
frame); an empty client still full-pulls. Update `docs/sync-strategies.md`
(resume path).

---

## G9 — [P2] No "facts since `<timestamp>`" on the wire (`afterTime`)

**Where it showed up:** device/edge sync re-analysis (2026-08-16) — "new facts
since 01-01-2026" is the natural device catch-up query; today catch-up is only
`afterTx` (an opaque tx id).

**Location:** `packages/client/src/sync.ts` + `packages/server/src/index.ts`
(`handleSync`), REST `GET /facts` (`filteredFacts`).

**Work:**
- Read helper first (ties to G4): `db.txAtOrBefore(timestamp)` — the last tx
  with `timestamp <= t`, via a binary search over the ledger.
- Accept `afterTime` in the `sync` message; the server maps it to `afterTx` and
  reuses the existing catch-up path.
- Optional: `GET /facts?since=<ms>` returning facts with `tx > afterTx(ms)`.

**Acceptance:** server test — a `sync` with `afterTime` streams exactly the
facts committed at/after that timestamp; client test for `txAtOrBefore`.
Depends on: **G4**.

---

## G10 — [P2] Persisting the syncing mirror (durable local cache)

**Where it showed up:** device/edge sync re-analysis (2026-08-16) — the mirror
must survive reboots: persist each applied transaction to an adapter.

**Location:** `packages/client/src/sync.ts` (+ `packages/persistence` types).

**Work:**
- Add an optional `adapter?: StorageAdapter` to `createSyncingClient`: after
  each applied transaction (full pull or live sync-event) append it via
  `adapter.append(tx, facts)`; on start, if the adapter holds data, restore it
  into the seeded client (ties to G8).
- Keep it optional — the in-memory mirror stays the default.

**Acceptance:** `sync.test.ts` with a fake adapter — transactions applied by the
mirror are appended; a client seeded from the adapter resumes with the correct
watermark. Update `docs/client-guide.md` (device/cache pattern).
Depends on: **G8**.

---

## Explicitly out of scope (documented non-goals, not tasks)

- **Collaborative ordering conflicts** (LiveBoard: two tabs dropping into the
  same column can collide on `card/order`) — fixing this is CRDT/multi-writer
  territory, a PLAN.md non-goal.
- **Offline-first multi-writer** (a device that accumulates writes while
  disconnected and reconciles with peers) — the supported model is
  read-locally-offline / write-to-server-when-online.
- **P2P / mesh fact relay** — sync is star-shaped through the server; tx ids are
  per-database, so there is no cross-client order authority. The supported
  "hand-off" form is snapshot export/import.
- **High-throughput telemetry** — single in-memory server; not a Kafka/Influx
  replacement.

## How to track

Each item above should be logged in [`issues.md`](../issues.md) as an `open`
entry (format: `## [YYYY-MM-DD] <area> — <short title>`) when work starts, and
flipped to `fixed` with a `Resolution` once the acceptance criteria pass.

