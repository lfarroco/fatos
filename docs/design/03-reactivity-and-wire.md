# 03 — Reactivity & Wire: Live Queries, EventTarget, React, Transport

Status: **Approved — not yet implemented.**

## Reactivity principle

Reactive reads re-evaluate **only when facts relevant to the query change** — never on
every transaction. Today the client notifies all listeners on every write, and the React
hooks re-render on every notification because their snapshots are fresh references. This
design fixes both.

## Access-tracking live queries

```ts
const admins = db.live(db => db.find('user', user => user['user/active'] === true));
admins.current;        // EntityState[]
admins.subscribe(cb);  // on change
admins.dispose();
```

- While `fn` runs, the engine wraps candidate entities in a Proxy; reads of
  `user['user/active']` are recorded.
- Recorded `(attribute)` set → candidate set via the AEVT index → subscription key. Writes
  touching only unrelated attributes do **not** re-run `fn`.
- `fn`'s result is memoized and diffed so consumers are notified only on actual change.
- Proxy overhead is opt-in (only inside `live`); data-driven `find`/`query` stay the hot
  path.
- Reference implementation pattern: React Compiler / MobX-style access tracking.

Explicit-dependency variant (no Proxy):

```ts
db.live(['user/active'], () => db.find({ 'user/active': true }));
```

## EventTarget client

The client extends `EventTarget` — the native browser/Node idiom:

```ts
client.addEventListener('fact:added', e => console.log(e.fact));
client.addEventListener('transaction:committed', e => console.log(e.transaction));
client.dispatchEvent(new FactEvent('fact:added', { fact }));
```

- The existing `subscribe(cb)` becomes sugar over `addEventListener`.
- Event names mirror the server's current `fact:added`, `fact:retracted`,
  `transaction:committed`.

## Async iterables

```ts
for await (const rows of db.liveQuery({ 'user/role': 'admin' })) {
  render(rows);
}
```

- `liveQuery` returns an `AsyncIterable` that yields the initial result, then each change.
- Cancellation via `AbortSignal`: `liveQuery(spec, { signal })`.
- The server streams the same shape over WebSocket.

## React hooks

```ts
const admins = useQuery(db => db.find('user', user => user['user/active'] === true));
const count  = useQuery(db => db.find('user', u => u['user/active']).length);
const alice  = useEntity(aliceId);
const at     = useTransaction();          // unchanged
```

- Hooks accept either a criteria/`QuerySpec` or a selector function (live).
- Snapshots are cached and memoized per query key so `useSyncExternalStore` bails out when
  nothing relevant changed.
- All hooks still require `FatosProvider`; `useFatosClient()` is unchanged.

## Wire protocol

### JSON type tags

Values beyond plain JSON are tagged (see [01-data-model.md](./01-data-model.md)):
`{ "$ref": … }`, `{ "$date": ms }`, `{ "$bigint": "…" }`. Facts keep their 5-tuple shape on
the wire.

### REST

| Endpoint | Body | Returns |
|---|---|---|
| `POST /transact` | `{ entries, metadata }` | `{ facts, transaction }` (existing) |
| `POST /query` | `{ spec, tx? }` | `{ rows }` — **new** |
| `GET /facts?…` | — | filters (existing) |
| `GET /facts/:eid?tx=` | — | entity snapshot (existing) |

### WebSocket

```
→ { type: 'subscribe', id, spec: QuerySpec, afterTx? }
← { type: 'subscribed', id }
→ on match: { type: 'facts', id, rows }
← { type: 'unsubscribe', id }
```

- Server keeps one subscription registry per client and pushes only for subscribed specs
  (server-side mirror of `live` semantics).
- The raw `fact:added` / `transaction:committed` fan-out stays for DevTools/audit streams.

## Catch-up primitive (`afterTx`)

- Clients include `afterTx` in subscribe; the server streams committed facts since that tx,
  then live updates.
- This is the only sync primitive in scope. Full offline/CRDT sync stays a non-goal.

## Explicit non-goals

- Distributed replication, CRDT conflict resolution, offline-first — unchanged from
  PLAN.md.

## Open questions

1. `live` selector shape: `db.find('user', fn)` vs `db.find(fn)` — confirm the
   entity-type/selector signature.
2. Should `live` also accept a `QuerySpec` directly (no Proxy)? *(Leaning: yes.)*
3. EventTarget events: one generic `'facts'` event vs typed per-fact events — confirm.
4. React selector hooks: server-render / Suspense story deferred until after sync work.
