# @fatos/react Guide

This guide explains how to connect `@fatos/client` to React with `@fatos/react` hooks.

## Install

```bash
npm install @fatos/client @fatos/react react
```

## Create and provide a client

Wrap your app with `FatosProvider`.

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import { createClient } from '@fatos/react';
import { FatosProvider } from '@fatos/react';
import { App } from './App';

const client = createClient();

client.add(1, 'user/name', 'Alice');
client.add(1, 'user/role', 'admin');

createRoot(document.getElementById('root')!).render(
  <FatosProvider client={client}>
    <App />
  </FatosProvider>
);
```

`useFatosClient` and all data hooks require `FatosProvider`.

## Hooks overview

`@fatos/react` provides:

- `useFatosClient()` for direct client access
- `useQuery(criteria)` for criteria-based entity lists
- `useDatalogQuery(spec)` for Datalog query rows
- `useEntity(eid)` for one entity by id
- `useTransaction()` for transaction history

## useQuery example

```tsx
import { useQuery } from '@fatos/react';

export function AdminList() {
  const admins = useQuery({ 'user/role': 'admin' });

  return (
    <ul>
      {admins.map((user) => (
        <li key={user.id}>{String(user['user/name'])}</li>
      ))}
    </ul>
  );
}
```

`useQuery` re-renders when matching entities change.

## useEntity example

```tsx
import { useEntity } from '@fatos/react';

export function UserCard({ eid }: { eid: number }) {
  const user = useEntity(eid);

  if (!user) {
    return <p>User not found</p>;
  }

  return (
    <article>
      <h2>{String(user['user/name'])}</h2>
      <p>Role: {String(user['user/role'] ?? 'unknown')}</p>
    </article>
  );
}
```

## useDatalogQuery example

```tsx
import { useDatalogQuery } from '@fatos/react';

export function ActiveUserCount() {
  const rows = useDatalogQuery({
    find: ['?e'],
    where: [['?e', 'user/active', true]]
  });

  return <p>Active users: {rows.length}</p>;
}
```

## useTransaction example

```tsx
import { useTransaction } from '@fatos/react';

export function Timeline() {
  const transactions = useTransaction();

  return (
    <ol>
      {transactions.map((tx) => (
        <li key={tx.id}>
          tx {tx.id} at {new Date(tx.timestamp).toLocaleString()}
        </li>
      ))}
    </ol>
  );
}
```

## Perform writes from components

Use `useFatosClient` when you need to add/retract/transact in event handlers.

```tsx
import { useFatosClient } from '@fatos/react';

export function AddUserButton() {
  const client = useFatosClient();

  const addUser = () => {
    const id = Date.now();
    client.transact([
      ['add', id, 'user/name', 'New User'],
      ['add', id, 'user/active', true]
    ]);
  };

  return <button onClick={addUser}>Add user</button>;
}
```

## Error to avoid

If a component uses any Fatos hook outside `FatosProvider`, it throws:

```txt
useFatosClient must be used within FatosProvider
```

## Next step

For lower-level client APIs and observers, see [client-guide.md](./client-guide.md).
