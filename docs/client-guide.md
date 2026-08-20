# @fatos/client Guide

This guide shows how to use `@fatos/client` to store immutable facts, query entities, and subscribe to changes.

## Install

```bash
npm install @fatos/client
```

If you are working in this monorepo, dependencies are already managed through workspaces.

## Create a client

```ts
import { createClient } from '@fatos/client';

const client = createClient();
```

`createClient()` returns an in-memory `FatosClient` instance.

## Add and retract facts

Facts are modeled as `(entityId, attribute, value)`.

```ts
client.add(1, 'user/name', 'Alice');
client.add(1, 'user/email', 'alice@example.com');
client.add(2, 'user/name', 'Bob');

client.retract(2, 'user/name', 'Bob');
```

Ergonomic tuple input is also supported:

```ts
client.add(['eid1', 'name', 'Alice']);
client.add(['eid1', 'name', 'Alicia']);
```

When no schema cardinality is declared, the latest add becomes the current value in `entity()` results.

## Transactional writes

Use `transact` to apply multiple entries atomically.

```ts
client.transact([
  ['add', 1, 'user/role', 'admin'],
  ['add', 2, 'user/role', 'viewer']
]);
```

You can also use ergonomic tuple lists (treated as add operations):

```ts
client.transact([
  ['eid1', 'name', 'Alice'],
  ['eid1', 'name', 'Alicia'],
  ['eid2', 'name', 'Bob']
]);
```

You can also pass optional metadata:

```ts
client.transact(
  [['add', 1, 'user/active', true]],
  { source: 'seed-script' }
);
```

### Object-map authoring

For ergonomic, JSON-style writes use `insert`, `set`, and `merge` — the object-map
grammar (design/02). These go through the same transaction + event path as `transact`,
so live queries and observers update exactly as with tuple entries.

```ts
// Create entities. `id` is optional (the engine allocates when omitted);
// string ids are first-class; arrays become cardinality-many facts.
const aliceId = client.insert({ 'user/name': 'Alice', 'user/tags': ['ts', 'db'] });
const ids = client.insert([
  { id: 'user:2', 'user/name': 'Bob', 'user/manager': ref(aliceId) }
]);

// Update an existing entity: `set` diffs against current state and emits
// retract+add pairs in one transaction (`null` removes an attribute).
client.set(aliceId, { 'user/name': 'Alicia' });
client.patch(aliceId, { 'user/role': null });

// Reconcile several entities from an eid-keyed map in one transaction —
// ideal for ingesting a JSON document.
client.merge({
  'user:2': { 'user/name': 'Roberta', 'user/age': 33 },
  'order:1': { 'order/item': ref(aliceId), 'order/status': 'placed' }
});
// merge keys are strings; for numeric entity ids use the single form:
client.mergeEntity(1, { 'user/name': 'One' });
```

- `insert` is create-oriented — writing a different value to an existing
  cardinality-one attribute throws (`Cardinality conflict`).
- `merge`/`mergeEntity` reconcile — changed one-valued attributes retract+add,
  `null` removes, many-valued attributes reconcile their member sets, and fresh
  arrays / nested objects auto-declare schema like `insert`.
- `upsert` is `insert` with the same semantics (identity-unique attributes
  resolve to the existing entity).

### Client reads and time travel (complete surface)

`FatosClient` mirrors the core database API, so a single handle covers the whole
surface — no need to also hold a raw `FactDatabase`:

```ts
const past = client.at(tx).find({ 'user/role': 'admin' }, { orderBy: ['user/name', 'asc'] });
const diff = client.diff(tx - 1, tx);        // { added, retracted } for undo/diff UIs
const nested = client.pull(aliceId, 'user.name user.manager.user.name');
const snapshot = { facts: client.getFacts(), transactions: client.getTransactions() };
client.restore(snapshot);                    // rebuild state from a snapshot
```

The low-level `client.db` handle is exposed for advanced use; prefer the client
methods so `fact:added` / `transaction:committed` events fire.

## Read data

### Read an entity

```ts
const user = client.entity(1);
// => { id: 1, 'user/name': 'Alice', 'user/email': 'alice@example.com', ... }
```

### Find entities by criteria

```ts
const admins = client.find({ 'user/role': 'admin' });
```

`find` also accepts the core options — `orderBy`, `limit`, `offset`, and `select`:

```ts
const newest = client.find({ 'user/role': 'admin' }, {
  orderBy: ['user/createdAt', 'desc'],
  limit: 10,
  select: ['user/name', 'user/email']
});
```

### Access raw facts and transactions

```ts
const facts = client.getFacts();
const txHistory = client.getTransactions();
```

## Query API

Use `query` for Datalog-style querying via a `QuerySpec`.

```ts
const rows = client.query({
  find: ['?e', '?name'],
  where: [
    ['?e', 'user/name', '?name']
  ]
});
```

The result is `QueryTerm[][]` (rows/tuples).

## Time-travel reads

Read as-of a specific transaction id with `atTransaction(tx)`.

```ts
const now = client.entity(1);
const lastTx = client.getTransactions().at(-1)?.[0];

if (lastTx !== undefined) {
  const pastUser = client.atTransaction(lastTx).entity(1);
}
```

The `atTransaction(tx)` view's `find` accepts the same options as `client.find`,
so past state can be ordered / paged / picked too:

```ts
const pastAdmins = client.atTransaction(lastTx).find(
  { 'user/role': 'admin' },
  { orderBy: ['user/name', 'asc'] }
);
```

When you know a wall-clock time instead of a transaction id, map it first:
`txAtOrBefore(ms)` returns the last transaction whose commit timestamp is at or
before `ms` (0 when none qualifies yet), and `atTime(ms)` is the
`atTransaction(txAtOrBefore(ms))` view — "state as of `<time>`":

```ts
const sinceYesterday = Date.now() - 24 * 60 * 60 * 1000;
const tx = client.txAtOrBefore(sinceYesterday);
const yesterdayUser = client.atTime(sinceYesterday).entity(1); // same as atTransaction(tx)
```

## Reactivity and subscriptions

### Low-level store subscription

```ts
const unsubscribe = client.subscribe(() => {
  console.log('Database changed');
});

client.add(3, 'user/name', 'Carol');
unsubscribe();
```

### Observe helper methods

`@fatos/client` includes observer helpers that emit only when results actually change.

```ts
const stopUsers = client.observe({ 'user/role': 'admin' }, (users) => {
  console.log('admins changed', users);
});

const stopEntity = client.observeEntity(1, (entity) => {
  console.log('entity 1 changed', entity);
});

const stopQuery = client.observeQuery(
  {
    find: ['?e'],
    where: [['?e', 'user/active', true]]
  },
  (rows) => {
    console.log('active users changed', rows);
  }
);

const stopTx = client.observeTransactions((txs) => {
  console.log('transactions changed', txs.length);
});

// later...
stopUsers();
stopEntity();
stopQuery();
stopTx();
```

## Server-backed clients (syncing client)

For apps that need a live mirror of a Fatos server (a browser tab, an edge
device), `createSyncingClient` keeps a local `FatosClient` in sync over a
WebSocket and adds server-authoritative write-through on the same handle:

```ts
import { createSyncingClient } from '@fatos/client';

const syncing = createSyncingClient({ url: 'ws://localhost:4000/ws', onError: console.error });
syncing.start();

// Write-through: POSTs to the HTTP base derived from the ws url
// (ws://localhost:4000/ws → http://localhost:4000/transact).
await syncing.transact(
  [['add', 1, 'user/name', 'Alice']],
  { actor: 'me' }
);
```

The server commits the transaction and broadcasts it back over the sync
socket; the local mirror applies the broadcast, so `syncing.client` (and any
React bindings on it) sees the write without a manual refresh. `sync.add(...)`
and `sync.retract(...)` are sugar for single-entry writes. The object-map
authoring surface is available too — `sync.insert(maps)`, `sync.set(eid,
changes)`, and `sync.merge({eid: attrs})` plan the write against the live
mirror and POST the resulting entries (with metadata). Entry values are
wire-tagged, so `Date` / `bigint` / ref values round-trip. See
[sync-strategies.md](./sync-strategies.md) for the sync protocol details.

### Durable device cache (resume across reboots)

Pass a `StorageAdapter` (from `@fatos/persistence`) as `adapter` to make the
mirror durable — the device/cache pattern for edge apps that reboot:

```ts
import { createSyncingClient } from '@fatos/client';
import { FileAdapter } from '@fatos/persistence';

const adapter = new FileAdapter({ filePath: 'mirror.json' });
const syncing = createSyncingClient({ url: 'ws://localhost:4000/ws', adapter });
syncing.start();
```

- **Writes go to the cache**: every applied transaction (full pull, incremental
  catch-up, or live sync-event) is appended via `adapter.append(transaction,
  facts)` — or a full snapshot `save()` for adapters without the fast path.
- **Reboots resume incrementally**: on the first connect, `adapter.load()` is
  restored into the mirror, so the resume watermark is the cache ledger head
  and only the delta since the last session is re-synced (no re-pull of the
  whole world). `syncing.client` is replaced by the restored mirror and
  `onClientReplaced` fires — re-bind your app the same way you do for a
  full-pull fallback.
- The caller owns the adapter's lifecycle — the syncing client never closes it.
  An empty cache (or no `adapter` at all) keeps the in-memory mirror + full
  pull as the default.

## Types you can import

```ts
import type {
  DatabaseSnapshot,
  DiffResult,
  EntityState,
  Fact,
  FatosClient,
  InsertMap,
  MergeMap,
  PullPath,
  QuerySpec,
  QueryTerm,
  TransactionEntry,
  TransactionRecord
} from '@fatos/client';
```

## Next step

For React apps, see [react-guide.md](./react-guide.md).
