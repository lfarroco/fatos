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
const txId = client.getTransactions().at(-1)?.id;

if (txId !== undefined) {
  const pastUser = client.atTransaction(txId).entity(1);
}
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

## Types you can import

```ts
import type {
  EntityState,
  Fact,
  FatosClient,
  QuerySpec,
  QueryTerm,
  TransactionEntry,
  TransactionRecord
} from '@fatos/client';
```

## Next step

For React apps, see [react-guide.md](./react-guide.md).
