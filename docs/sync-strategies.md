# Sync Strategies: Full Snapshot Pull vs. `afterTx` Incremental Catch-up

Status: **Implemented (Phase 6).** Companion to
[03-reactivity-and-wire.md](./03-reactivity-and-wire.md) (the `afterTx`
catch-up primitive) and `packages/client/src/sync.ts`
(`createSyncingClient`).

## The two strategies

A syncing client keeps a local `FatosClient` mirror of a Fatos server over a
single WebSocket using the `sync` message — the full-facts counterpart of the
spec-scoped `subscribe` registry:

```
→ { type: 'sync', id, afterTx? }
← { type: 'synced', id }
← { type: 'facts', id, facts }            // facts with tx > afterTx
← { type: 'transactions', id, transactions } // ledger with tx > afterTx
← { type: 'sync-event', id, event }       // live transaction:committed events
```

Values in `facts` use the standard wire tags (`$ref` / `$lookupRef` / `$date` /
`$bigint`); the client deserializes before replay. The live subscription is
registered *before* the catch-up is computed and sent, and the whole exchange
runs synchronously in one event-loop tick, so no commit can fall into the gap
between the catch-up snapshot and the live stream.

### 1. Full snapshot pull

- **When**: first connect with an empty local client; the recovery path after
  an incremental apply fails (divergence).
- **How**: `afterTx` is omitted; the server streams the whole fact log + ledger
  and the client rebuilds with `db.restore()` — the only replay path that
  preserves schema facts verbatim (negative schema eids are never remapped).
- **Cost**: O(total facts) transfer and rebuild. The client instance is
  replaced; apps re-bind to `syncingClient.client`
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

## Failure & recovery

- `transact()` is atomic per transaction, so the incremental replay advances
  the watermark per applied tx and can resume from the last success on the next
  reconnect.
- If an incremental apply throws (e.g. a replay edge case), the module flags
  itself for a full pull, closes the socket, and on the next connect omits
  `afterTx` — the mirror is rebuilt from a fresh snapshot. This is the
  documented divergence escape hatch.

## When to use which

| Situation | Strategy |
|---|---|
| First connect / fresh client | Full pull (`restore`) |
| Reconnect with a healthy mirror | `afterTx` catch-up (`transact` delta) |
| Incremental apply failure | Full pull fallback (client replaced) |
| Small datasets, simple ops | Either; full pull is simpler and still fine |

The syncing client picks automatically; the REST endpoints
(`GET /facts`, `GET /transactions`) remain available for one-shot full pulls
and for tools that never need live updates.

## Limitations (per PLAN non-goals)

- **No offline-first / CRDT conflict resolution.** This is a live mirror, not a
  multi-writer store: the server is authoritative, and clients never write
  while disconnected.
- **No distributed replication.** One server → many mirroring clients; a
  syncing client does not re-serve writes or gossip.
- **No conflict detection for concurrent local writes.** Writes made to the
  local client while it is not the current mirror are overwritten by the next
  full pull or catch-up; the watermark always tracks the server's tx numbers.
- **Transaction metadata is not value-tagged on the wire** (Date/bigint in
  metadata survive as their JSON forms), matching the existing
  `GET /transactions` behavior.
- **Text frames only.** The sync protocol uses JSON text frames; the client
  ignores non-string message data.
