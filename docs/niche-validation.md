# Niche Validation — Three Demo Apps, One Library

> Companion to the three demo packages added to this repo:
> `packages/app-ops-desk`, `packages/app-replay`, `packages/app-liveboard`.
> Each is a thin, runnable app that probes one candidate niche and ends with a
> verdict README. This document triangulates them.

## Why three apps

Fatos is a temporal fact database: facts are `[eid, attribute, value, tx, op]`,
append-only, with `at(tx)` time travel, `diff(txA, txB)`, live queries, a
syncing client, and server + persistence. That feature set suggests several
market niches, and they lead to different product directions — so instead of
picking one, we built one demo per candidate and asked each a different
question.

| App | Niche probe | Question it answers |
|---|---|---|
| `app-ops-desk` | Audit-heavy operations (fulfillment, inventory, approvals) | Is "history + who/what/when" **load-bearing** for the product? |
| `app-replay` | Time-travel debugging / replay / undo (builders, agent sessions) | Does the temporal core make something **otherwise hard** trivial? |
| `app-liveboard` | Realtime multi-client boards (kanban, dashboards) | Does the realtime story hold up **without** the temporal angle? |

## What the probes found

### 1. Audit-heavy operations — **strong fit, the most natural market**

Every requirement the ops demo implements (audit trail, "state as of last
Tuesday", immutable history, actor metadata per change, schema/unique
validation at the DB layer) is a *free consequence of the data model*, not
applied scaffolding. Two browser clients + a persistent server worked end to
end; the demo even caught a cardinality violation over REST during smoke
testing. No bolt-on event sourcing, no separate audit table.

### 2. Time-travel debugging / replay — **strong fit, the most differentiated**

A flow builder with scrub-to-any-tx, per-step diff, undo-that-preserves-history,
ref-based edges, and snapshot export/import came out of ~300 lines against the
existing `at`/`diff`/`ref`/`restore` API. This is the closest probe to a
capability that is *hard to build without* a temporal store — and it synergizes
with the existing DevTools extension + schema designer.

### 3. Realtime boards — **decent, but not differentiating alone**

Two tabs sync over WebSocket and per-column live queries re-render precisely;
the plumbing is solid. But any realtime store could carry a kanban. The
temporal core only earns its keep where the other two probes already won
(activity log = transaction log, "as of" debugging, queryable projection of a
log).


## Reframing — the fact-log sync thesis (follow-up, 2026-08-16)

A fourth candidate emerged after the demos: **device / edge state sync** —
local caches that reboot and ask "new facts since …", with fact payloads
relayed between clients. Re-examining the sync protocol (not just the demos)
reframes the library's strongest asset:

> **Fatos is a server-authoritative fact log where every local cache is a
> replayable slice of the same log — read locally, catch up incrementally,
> rebuild from any point.**

What is already true in the code:

- **The fact log IS the sync payload.** The `sync` WS message streams facts +
  ledger: fresh clients get a compact current-state snapshot, returning clients
  get an `afterTx` incremental delta, then live `transaction:committed` events.
  The server is a natural relay — REST writes append to the log, fan-out
  broadcasts to every synced client, catch-up fills gaps.
- **Durable local caches exist on both runtimes.** `IndexedDBAdapter` (browser)
  and `FileAdapter` (Node) store a snapshot plus an append log keyed by tx.
- **Transactions carry timestamps**, so "facts since 01-01-2026" is expressible
  once a timestamp→tx mapping exists.

Three small gaps stand between this thesis and a product (detailed in
[niche-gap-tasks.md](./niche-gap-tasks.md)):

| Gap | What's missing |
|---|---|
| **G8** | `createSyncingClient({ client })` doesn't derive the initial `afterTx` watermark from a restored mirror's ledger — a device that rebooted with a cache always does a full pull instead of resuming incrementally |
| **G10** | No built-in persistence of the mirror — applied sync-events must be appended to an adapter manually |
| **G9** | No timestamp→tx mapping (`db.txAtOrBefore`) and no `afterTime` on the sync message / `GET /facts?since=` — "new facts since a date" isn't first-class |

### Why this reframe matters

The earlier realtime-boards probe was weak because a websocket alone carries a
kanban. The device/catch-up story is different: the **log position** is the
cache identity, **resuming** is a temporal query, and the local store is a
**replayable slice** of the same history — the temporal machinery is doing the
work, not just the transport.

**Shines:**
- Operations/workflow at the edge (fleets, kiosks/POS, field devices): audit +
  live HQ dashboards + "what was the state at Tuesday 2pm".
- Intermittently connected clients: read locally offline, catch up on
  reconnect, resume from a watermark.
- Replay/debugging tooling (unchanged — the moat).

**Does not shine (honest limits):**
- **Offline-first multi-writer** — a device accumulating writes while
  disconnected and reconciling with peers is CRDT territory (non-goal). The
  supported model is read-locally-offline / write-to-server-when-online.
- **High-throughput telemetry** — single in-memory server; not a Kafka/Influx
  replacement for sensor firehoses.
- **P2P/mesh topologies** — star relay only; tx ids are per-database, so there
  is no cross-client order authority. The supported "hand-off" form is snapshot
  export/import (used by the Replay app).

## Recommendation

**Primary niche: audit-heavy operations / workflow software.** It is the largest
market of the three, the one where temporal history is a *core requirement*
rather than a nice-to-have, and the one where Fatos's full stack (schema
validation, live dashboards, persistence, multi-client sync) all earn their
place.

**Second bet: developer-facing replay/debugging tooling** (flow/form builders,
AI-agent session recorders, low-code canvases). This is the *moat* — the
temporal core is the product, and it pairs with the existing DevTools +
schema-designer assets.

**New third axis — device / edge state sync is the *distribution* story.**
The fact-log sync substrate (afterTx catch-up, durable mirrors, temporal
"since" queries) is the piece every client-side-cache app needs, and it is
mostly built — closing G8/G9/G10 turns it into a product feature. It is also the
sharpest *external* pitch: "your local cache is a replayable slice of the same
log."

**Avoid marketing as:** "a realtime database" (Firestore/Supabase territory) or
"a Kafka/event-log replacement" (scale and query-power gaps are documented
non-goals).

## Suggested positioning sentence

> Fatos is the database for applications that need to *remember everything and
> keep every copy in sync*: operations systems that answer "what was the state,
> who changed it, and why", developer tools where state history is the feature,
> and devices whose local cache is a replayable slice of one fact log.


## Follow-ups if this direction is right

- Elevate the Ops Desk pattern into the documented "reference app": seed →
  REST writes with actor metadata → live dashboard → `at(tx)` reporting →
  restart recovery.
- Close the small gaps the probes surfaced: expose `orderBy`/`select` on the
  client `find`, unwrap `ref()` values to plain ids in entity reads by default,
  and add a `txMetadata` convenience.
- Build one "AI agent session recorder" variant of `app-replay` — it is the
  most current and shareable demo of the temporal niche.
- Close **G8 / G9 / G10** (watermark-resume, `afterTime`, persist-mirror) and
  validate the device/edge thesis with a **FieldSync** demo app (build spec:
  [docs/app-fieldsync-design.md](./app-fieldsync-design.md)): a device panel
  with an IndexedDB-backed cache, a Reboot button that resumes from the cache,
  a "catch up since `<date>`" control, and a second HQ dashboard client seeing
  the same facts live.
