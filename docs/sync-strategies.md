# Sync Strategies: Snapshot Pull, `afterTx` Incremental, and `afterTime` Catch-up

Status: **Implemented (Phase 6).** Companion to
[03-reactivity-and-wire.md](./03-reactivity-and-wire.md) (the `afterTx`
catch-up primitive) and `packages/client/src/sync.ts`
(`createSyncingClient`).

## The strategies

A syncing client keeps a local `FatosClient` mirror of a Fatos server over a
single WebSocket using the `sync` message — the full-facts counterpart of the
spec-scoped `subscribe` registry:

```
→ { type: 'sync', id, afterTx?, afterTime? }
← { type: 'synced', id }
← { type: 'snapshot', id, facts, transactions }   // fresh pull (no afterTx):
                                                  //   current-state facts + full ledger
← { type: 'facts', id, facts }            // facts with tx > afterTx (chunked on a huge pull)
← { type: 'transactions', id, transactions } // ledger with tx > afterTx
← { type: 'sync-event', id, event }       // live transaction:committed events
```

`afterTime` (ms epoch) is an alternative to `afterTx`: the server maps it to a
tx boundary via the ledger and streams exactly the facts committed **at/after**
that timestamp — "facts since `<time>`". An explicit `afterTx` wins over
`afterTime` when both are present.

Values in `facts` and transaction metadata use the standard wire tags (`$ref` /
`$lookupRef` / `$date` / `$bigint`); the client deserializes before replay. The live
subscription is registered *before* the catch-up is computed and sent, and the whole
exchange runs synchronously in one event-loop tick, so no commit can fall into the gap
between the catch-up snapshot and the live stream.

### 1. State snapshot pull (fresh clients)

- **When**: first connect with an empty local client; the recovery path after
  an incremental apply fails (divergence).
- **How**: `afterTx` is omitted; the server streams a `snapshot` frame carrying the
  minimal current-state fact set (only the latest asserted `'add'` fact per
  `(eid, attribute, value)` triple — bounded by active state, not history) plus the
  full ledger, and the client rebuilds with `db.restore()` — the only replay path
  that preserves schema facts verbatim (negative schema eids are never remapped).
  The local watermark is set to the ledger head (the server's real tx), so a later
  reconnect catches up incrementally from the true frontier.
- **Cost**: O(active state) transfer and rebuild instead of O(total history). The
  client instance is replaced; apps re-bind to `syncingClient.client`
  (`onClientReplaced` fires).

### 2. `afterTx` incremental catch-up

- **When**: reconnect after a drop, when the local mirror is non-empty.
- **How**: `afterTx` is the highest server tx fully applied locally (the
  watermark). The server streams only facts/transactions with `tx > afterTx`,
  and the client replays the delta one transaction at a time via
  `client.transact()` on the **same** client instance — React bindings keep
  working across reconnects.
- **Schema replay**: schema facts in the delta are converted back into
  `SchemaDeclaration` entries (`factsToTransactionEntries`) — replaying them as
  raw facts through `transact` would remap the negative schema eids as tempids
  and corrupt the local schema. `restore()` is therefore only safe for the
  full-pull path; `transact` + declaration reconstruction is the incremental
  path.

### 2b. Resuming from a restored cache

Passing a pre-populated `client` (e.g. one restored from a durable
IndexedDB/File cache after a reboot) derives the initial watermark from the
mirror's ledger head, so the first connect is an incremental `afterTx`
catch-up against the real server frontier — the device re-syncs only what
changed while it was off, instead of re-pulling the world. An empty
`client` (or a divergence full-resync) keeps the full-pull path unchanged.

### 3. `afterTime` time-based catch-up

- **When**: a device/app that knows a wall-clock time instead of a tx id —
  "new facts since 01-01-2026". `createSyncingClient({ afterTime: ms })` seeds
  the **first** connect with `afterTime`; once the catch-up applies, the local
  watermark (the streamed ledger head) takes over and reconnects use `afterTx`
  as usual.
- **How**: the server maps `afterTime` to a tx boundary with the same
  binary-search helper the time-travel reads use (`txBefore`), then reuses the
  `afterTx` catch-up path unchanged — chunked `facts` + `transactions` frames,
  so the "at/after" boundary is exact (a transaction committed at exactly the
  given timestamp is included).
- **HTTP equivalent**: `GET /facts?since=<ms>` returns the same
  "facts committed at/after `<ms>`" set for one-shot pulls.
- **Cost**: identical to the `afterTx` catch-up (delta transfer + incremental
  replay). A client that has never synced applies the delta as a rebuild, the
  same as any first catch-up.

## Failure & recovery

- `transact()` is atomic per transaction, so the incremental replay advances
  the watermark per applied tx and can resume from the last success on the next
  reconnect.
- If an incremental apply throws (e.g. a replay edge case), the module flags
  itself for a full pull, closes the socket, and on the next connect omits
  `afterTx` — the mirror is rebuilt from a fresh snapshot. This is the
  documented divergence escape hatch.

## Writes

The syncing client is **not** read-only. `sync.transact(entries, metadata?)`
(plus the `sync.add(eid, attribute, value)` / `sync.retract(eid, attribute, value)`
sugar) POSTs to the HTTP base derived from the ws url — `ws://host/ws` →
`http://host`, `wss` → `https`, hitting the server's existing
`POST /transact`. Entry values are wire-tagged (design/03) so
`Date` / `bigint` / ref values round-trip losslessly; metadata is stored
verbatim. The server's broadcast then applies to the local mirror through the
existing `sync-event` path — a write is a single REST hop that the mirror
replays, so every tab stays consistent without any client-side write logic.

## Durable cache (device resume)

Pass an optional `adapter` (any `StorageAdapter` from `@fatos/persistence`) to
`createSyncingClient` to persist the mirror:

- **Full pull / first catch-up** → `adapter.save(snapshot)` replaces the cache
  with the restored mirror (server tx numbers + revived metadata).
- **Live sync-event / incremental catch-up** → `adapter.append(transaction,
  facts)` per applied transaction (falling back to a full snapshot `save()` for
  adapters without `append`). Writes are serialized in commit order.
- **Boot** → `adapter.load()` seeds the mirror (server tx numbers preserved),
  so the resume watermark is the cache ledger head and only the delta since the
  last session is re-synced. `onClientReplaced` fires (the restored mirror is a
  new client instance); an explicit `client` option wins over the cache.

The syncing client never closes the adapter — the caller owns its lifecycle.

## When to use which

| Situation | Strategy |
|---|---|
| First connect / fresh client | Full pull (`restore`) |
| Reconnect with a healthy mirror | `afterTx` catch-up (`transact` delta) |
| Reboot with a restored cache (`client` with a ledger) | `afterTx` catch-up from the ledger head |
| "Facts since `<time>`" on first connect | `afterTime` catch-up (`createSyncingClient({ afterTime })`) |
| Device that reboots | `adapter` cache + resume from the cache ledger head |
| Incremental apply failure | Full pull fallback (client replaced) |
| Small datasets, simple ops | Either; full pull is simpler and still fine |

The syncing client picks automatically; the REST endpoints
(`GET /facts`, `GET /facts?since=`, `GET /transactions`) remain available for
one-shot pulls and for tools that never need live updates.

## Limitations (per PLAN non-goals)

- **No offline-first / CRDT conflict resolution.** This is a live mirror, not a
  multi-writer store: the server is authoritative, and clients never write
  while disconnected.
- **No distributed replication.** One server → many mirroring clients; a
  syncing client does not re-serve writes or gossip.
- **No conflict detection for concurrent local writes.** Writes made to the
  local client while it is not the current mirror are overwritten by the next
  full pull or catch-up; the watermark always tracks the server's tx numbers.
- **Transaction metadata is value-tagged on the wire.** Since the B4.3 work, the
  server serializes transaction metadata with the design/03 tags (`$date` / `$bigint` /
  `$ref`) and the syncing client revives them before storage, so metadata round-trips
  losslessly on the sync path.
- **Text frames only.** The sync protocol uses JSON text frames; the client
  ignores non-string message data.
