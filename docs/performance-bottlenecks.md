# Performance Bottlenecks — Task List

Status: **In progress.** Identified during a server-side performance review (2026-08-15).
Each item below documents a bottleneck, the fix, and its status. Completed items link
the code that landed; deferred items are scoped follow-ups.

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

## B4 — Deferred / follow-up tasks

1. **State-snapshot sync for fresh clients.** A brand-new client still pulls the full
   append-only fact log (now chunked, so per-frame size is bounded, but total bytes are
   still O(n)). A compact "current entity states" pull would bound a fresh sync to the
   active state instead of all history. Protocol + client changes.
2. **Append modes for Postgres / Mongo / IndexedDB.** These still fall back to the
   full-snapshot `save()` per transaction. Postgres could append rows to a facts/ledger
   table; Mongo could insert per-transaction documents; IndexedDB could append to an
   object store. Schema/contract work, same `StorageAdapter.append` surface.
3. **Serialize the raw WS event fan-out values.** The design/03 raw `fact:added` /
   `transaction:committed` fan-out stringifies raw engine values; transactions
   containing Date / bigint / ref values would throw in `JSON.stringify` when clients
   are connected. The `sync` protocol already serializes properly (its `sync-event`
   path). The raw fan-out should serialize via the same wire tags.
4. **Fine-grained client reactivity.** `@fatos/client`'s `observe*`/`subscribe` notify
   all listeners on every write (documented in docs/design/03). The core `live` handle
   already prunes by relevance; the coarse client notification layer does not.
5. **Broadcast amplification on many subscribers.** Every `transaction:committed` /
   `fact:added` event is sent to every connected client even when only a subset is
   subscribed to the `sync`/`subscribe` protocols. Per-subscription filtering would
   bound fan-out by actual interest.
