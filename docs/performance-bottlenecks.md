# Performance Bottlenecks — Task List

Status: **Complete.** Identified during a server-side performance review (2026-08-15);
all items B1–B4 were implemented the same day. Each item below documents a
bottleneck, the fix, and its status. Completed items link the code that landed;
remaining notes are scoped follow-ups.

## Background

The Fatos "backend" (`packages/server`) is thin glue around the shared in-memory engine
(`packages/core`), which also runs in the browser via `@fatos/client`. The server's
steady-state hot paths are (a) persistence after each committed transaction and
(b) WebSocket fan-out / catch-up. The core engine benchmark (10k entities / 20k facts)
already meets every P0 target (ingest < 200 ms, single-clause query < 10 ms, 2-clause
join < 50 ms, find < 10 ms), so the bottlenecks below are about *server-side scaling
behavior*, not raw engine throughput.

## B1 — Full-snapshot persistence after every transaction (FIXED)

- **Where**: `FatosServer.persist()` captured `{ facts, transactions }` — the *entire*
  fact log and transaction ledger — and called `storage.save(snapshot)` after every
  committed transaction. The FileAdapter additionally pretty-printed the JSON.
- **Cost**: O(total facts) serialization + I/O per write. The dominant scaling ceiling:
  write cost grows with the size of the whole database, not the size of the change.
- **Fix**: an append-only fast path.
  - `StorageAdapter.append(transaction, facts)` — optional contract
    (`packages/persistence/src/types.ts`).
  - `FileAdapter` keeps a JSONL append log (`<snapshot path>.log`): each committed
    transaction is one line (O(transaction size)); `load()` replays the snapshot plus
    log entries newer than the snapshot's last tx (a checkpoint-then-crash-before-
    truncate never double-replays); `save()` is the compaction checkpoint that
    atomically replaces the snapshot and truncates the log. A partial trailing log
    line from a crash mid-append is dropped on read.
    (`packages/persistence/src/adapters/file.ts`, `packages/persistence/src/serialization.ts`)
  - `MemoryAdapter` implements `append` (`packages/persistence/src/adapters/memory.ts`).
  - The server uses `append` when the adapter supports it and compacts once on `stop()`
    (`packages/server/src/index.ts`).
  - Adapters without `append` (Postgres / Mongo / IndexedDB) fall back to the previous
    full-snapshot `save` — unchanged behavior.
- **Tests**: `packages/persistence/src/__tests__/file.test.ts` (append replay, snapshot
  + log merge, checkpoint truncation, partial trailing line, tx <= snapshot-max skip);
  `packages/server/src/index.test.ts` ("persists via append() … checkpoints on stop").
- **Measured** (FileAdapter, median per transaction): append stays flat while full
  save grows linearly —

  | facts | save (all facts) | append (1 fact) | ratio |
  |-------|------------------|-----------------|-------|
  | 1k    | 1.21 ms          | 0.194 ms        | 6.3x  |
  | 10k   | 10.06 ms         | 0.272 ms        | 37x   |
  | 50k   | 56.26 ms         | 0.288 ms        | 195x  |

## B2 — O(n) WebSocket catch-up per connection (FIXED — frame size bounded)

- **Where**: `handleSync` (full-fact-log sync, design/03 `afterTx` catch-up) sent the
  whole `facts` array since `afterTx` as **one** `{ type: 'facts', … }` frame. A fresh
  client received the entire history in a single oversized WebSocket frame (giant
  string build + buffering per connection).
- **Cost**: O(n) bytes serialized into one frame per fresh connection; peak memory
  proportional to the whole log.
- **Fix**: stream catch-up facts in bounded tx-ordered chunks (`SYNC_CATCH_UP_CHUNK`,
  currently 2000 facts/frame). The client (`packages/client/src/sync.ts`) accumulates
  `facts` frames (previously it *replaced* them, dropping all but the last) and applies
  the catch-up when the trailing `transactions` frame arrives. Facts stay ascending
  across chunks, preserving `restore()`'s ordering invariant.
- **Tests**: `packages/client/src/sync.test.ts` ("chunked catch-up"); server
  `packages/server/src/index.test.ts` ("streams full-log catch-up in bounded facts
  chunks").

## B3 — Broadcast re-stringifies the same event per client (FIXED)

- **Where**: `broadcastWebSocketEvent` called `JSON.stringify(event)` inside the
  per-client loop, re-serializing the identical payload N times (once per connected
  client) on the event loop of every committed transaction.
- **Fix**: stringify once when there is at least one connected client and `send()` the
  shared string (`packages/server/src/index.ts`). The zero-client guard preserves the
  original "no work when nobody is listening" behavior.

## B4 — Deferred / follow-up tasks (ALL FIXED)

1. **State-snapshot sync for fresh clients (FIXED).** A brand-new client no longer
   pulls the full append-only fact log. `handleSync` serves fresh pulls (no `afterTx`)
   a compact `snapshot` frame: the minimal current-state fact set (only the latest
   asserted `'add'` fact per `(eid, attribute, value)` triple, `currentStateFacts` in
   `packages/server/src/index.ts`) plus the full ledger, bounded by active state
   instead of history. The client (`packages/client/src/sync.ts`) rebuilds via
   `db.restore()`, which preserves schema facts verbatim; its watermark stays at the
   ledger head so a later reconnect catches up incrementally. The chunked full-log pull
   remains the fallback and the `afterTx` incremental path is unchanged.
   - Tests: server "streams a compact state snapshot for fresh pulls"; client
     `sync.test.ts` snapshot-path coverage.
2. **Append modes for Postgres / Mongo / IndexedDB (FIXED).** All three adapters now
   implement the `StorageAdapter.append(transaction, facts)` fast path, mirroring
   `FileAdapter`'s snapshot + append-log pattern (`packages/persistence/src/adapters/`):
   - `PostgresAdapter` — second table `fatos_log` (default, configurable via
     `options.logTable`), one row per committed transaction (`INSERT … ON CONFLICT (id)
     DO NOTHING`, id = tx); `load()` replays log rows with `id >` the snapshot's last tx.
   - `MongoAdapter` — per-transaction log documents; `load()` merges snapshot doc + log
     docs newer than the snapshot. The adapter exposes `append` only when the injected
     collection supports insertion; otherwise it omits it and the server falls back to
     `save()`.
   - `IndexedDBAdapter` — second object store keyed by tx; `load()` merges; `save()`
     remains the checkpoint that truncates the log.
   - Tests: per-adapter append-replay, checkpoint truncation, no-double-replay,
     save-then-append round-trips.
3. **Serialize the raw WS event fan-out values (FIXED).** The raw `fact:added` /
   `transaction:committed` fan-out now serializes through the design/03 wire tags:
   `serializeServerEventForWire` / `serializeTransactionRecord` /
   `serializeMetadata` (`packages/server/src/index.ts`) tag `$date` / `$bigint` /
   `$ref` values and tag transaction metadata, so `JSON.stringify` never throws
   (bigint) or silently corrupts refs to `{}` / Dates to untagged strings. The same
   serializers cover the SSE endpoint, the HTTP `/transact` responses, and the REST
   `GET /transactions` / `GET /facts/:id` responses (entity attribute values are
   wire-tagged too); the sync `sync-event` and `transactions` frames use them as well.
   - Tests: WS clients receiving transactions containing Date / bigint / ref values
     assert `$date` / `$bigint` / `$ref` wire tags round-trip; REST entity +
     transactions endpoints return tagged values.
4. **Fine-grained client reactivity (FIXED).** `@fatos/client`'s `observe` /
   `observeQuery` / `observeEntity` are now built on the core `db.live` handles
   (`packages/client/src/index.ts`), so a write touching attributes outside an
   observer's criteria never wakes it — the core tracker prunes by attribute (AEVT)
   before diffing, and the callback fires only on relevant, actually-changed results.
   `observeTransactions` stays on the every-write listener (ledger reads are not
   live-tracked; it already dedupes by `stableKey`).
   - Tests: client tests asserting observers do not fire on unrelated transactions and
     do fire on relevant ones.
5. **Broadcast amplification on many subscribers (FIXED — registry gating).** The raw
   `transaction:committed` / `fact:added` fan-out is the DevTools/audit stream
   (design/03) and now reaches only *bare* clients — those holding no `subscribe` or
   `sync` registration (`isRawStreamRecipient` in `packages/server/src/index.ts`).
   Clients with active registrations receive their own tailored frames (spec-filtered
   `facts` / `sync-event`) and are excluded from the redundant raw broadcast, so a
   fleet of sync/subscribe clients stops amplifying every commit to every connection.
   Per-spec filtering (only facts matching a client's `QuerySpec`s) is a scoped
   follow-up if fan-out volume still matters on large deployments.
   - Tests: a three-client test asserting bare clients receive raw events, subscribed
     (`subscribe`/`sync`) clients do not, and an unsubscribed client re-joins the stream.

### Remaining follow-ups (not part of B1–B4)

- Real-browser smoke test for the IndexedDB adapter (verified only against the test
  fake so far).
- `observeTransactions` could migrate to live handles if core ever tracks ledger reads.
- Per-spec raw-event filtering (only facts matching a client's subscriptions).
