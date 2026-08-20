# 02 — Transact & Query: JS-Native Authoring and Reading

Status: **Approved — implemented** (object maps, refs/upserts, `set`/`patch`
diffs, `find` operators, `pull`, and now `merge` are shipped on both the core
database and the `FatosClient`).

## Guiding principle

Every authoring and query API compiles down to one of two canonical core shapes:

- writes → `Mutation[]` (`['add'|'retract', eid, attribute, value]`)
- reads → `QuerySpec` (`{ find, where }`) plus pull paths

Sugar layers (object maps, nested graphs, builders, operators, dot-path `pull`) exist for
ergonomics and never bypass the fact log. This keeps the engine deterministic,
serializable, and inspectable in DevTools.

## Transact grammar

All forms below are valid entries for `db.transact(...)`. The recommended primary form is
object maps via `db.insert`.

### 1. Object maps (primary)

```ts
const [aliceId, bobId] = db.insert([
  { 'user/name': 'Alice', 'user/age': 22, 'user/tags': ['ts', 'db'] },
  { 'user/name': 'Bob', 'user/friend': ref(aliceId) }
]);
```

- `id` key omitted → engine allocates the id (returned in the same position).
- `id: -1` (tempid) accepted for Datomic familiarity; the same tempid in multiple maps
  resolves to the same entity within the transaction.
- `id` may be a stable string.
- Arrays expand into cardinality-many facts.
- `db.insert` returns `EntityId[]` aligned to input order.

The low-level form stays available:

```ts
db.transact([
  ['add', aliceId, 'user/name', 'Alice'],
  ['add', aliceId, 'user/age', 22]
]);
```

### 2. Nested object graphs

```ts
const aliceId = db.insert({
  'user/name': 'Alice',
  'user/address': { 'address/city': 'Berlin', 'address/zip': '10115' },
  'user/contact': [
    { 'contact/type': 'email', 'contact/value': 'a@b.c' },
    { 'contact/type': 'phone', 'contact/value': '+49 30 …' }
  ]
});
```

- Nested objects become entities with engine-allocated tempids.
- Deterministic flattening: depth-first, parent-major, so results are reproducible.
- A nested object can reference its parent (or a sibling) via `ref(tempHandle)` when
  explicit `temp()` handles are used.
- Arrays of objects become multiple nested entities, joined to the parent via a ref
  attribute (auto-declared as `db/cardinality: many` when the parent attribute is
  many-valued).
- Cycles are impossible in JSON literals; back-references use `ref()`.

### 3. Explicit refs & upserts

```ts
db.insert({ 'user/friend': ref(bobId) });
db.insert({ 'user/email': 'a@b.c', 'user/name': 'Alice' });   // creates
db.insert({ 'user/email': 'a@b.c', 'user/name': 'Alicia' });  // same entity, new name
db.upsert({ 'user/email': 'a@b.c', 'user/name': 'Alicia' });  // explicit form
```

- `upsert` (or `insert` containing a unique `identity` attribute) matches existing entities
  by unique attribute and adds facts to them instead of creating new ones.
- `db/unique: 'value'` raises on duplicate writes; `'identity'` participates in upsert.

### 4. Updates

```ts
db.set(aliceId, { 'user/name': 'Alicia' });   // same-tx retract+add for changed attrs
db.set(aliceId, 'user/age', 23);
db.retract(aliceId, 'user/tags', 'db');       // unchanged form
db.patch(aliceId, { 'user/name': 'Alicia', 'user/age': null }); // null = retract
```

- `set`/`patch` compute a diff against current entity state and emit retract+add pairs in
  one transaction.
- Deleting a many-valued item = `retract`; deleting a one-valued attribute = `set(attr,
  null)` / `patch` with null.

### 4b. Merge (eid-keyed reconcile)

```ts
db.merge({
  'user:2': { 'user/name': 'Roberta', 'user/age': 33 },
  'order:1': { 'order/item': ref(aliceId), 'order/status': 'placed' }
});
db.mergeEntity(7, { 'user/name': 'Seven' });   // single form; numeric or string ids
```

- Keys are entity ids; attribute maps reconcile against current state (`set`
  semantics) and expand new values like `insert` (arrays → cardinality-many,
  nested objects → ref entities, fresh attributes auto-declared).
- Distinct from `insert` (create-oriented, throws on a changed one-value) and
  `upsert` (resolves by `unique: 'identity'` attribute).
- `merge` keys are strings (JSON ingestion); numeric ids use `mergeEntity`.
- One transaction for the whole map; returns entity ids aligned to input order.
- The side-effect-free planners (`planInsert` / `planSet` / `planMerge`) power
  the write-through sugar on `SyncingClient` and `FatosServer`.

## Temp resolution rules

1. Every `temp()`/negative id in a transaction resolves to a fresh positive id at commit.
2. Two occurrences of the same tempid in the same transaction → same entity.
3. Nested objects get deterministic tempids (depth-first, parent-major).
4. `db.insert` returns resolved ids; `db.transact` keeps returning `Fact[]`.

## `find` — Mango-style operators

```ts
db.find(
  { 'user/role': { $in: ['admin', 'mod'] }, 'user/age': { $gte: 18, $lt: 65 } },
  { orderBy: ['user/age', 'desc'], limit: 20, offset: 0, select: ['user/name', 'user/role'] }
);
```

- Bare values are shorthand for `$eq`.
- For cardinality-many attributes, operators match against any member (`$contains`).
- `$exists` distinguishes null/absent from present.
- **This fixes today's broken `find` on array-valued attributes** (currently `Object.is`
  compares against the array reference).
- Internally desugars to `QuerySpec` — one evaluation engine.
- Returns `EntityState[]`; with `select`, returns `Pick<EntityState, …>[]`.

## `pull` — dot-path selection

```ts
db.pull(aliceId, 'user.name user.age user.friend.user.name');
// {
//   id,
//   'user/name': 'Alice',
//   'user/friend': { id, 'user/name': 'Bob' }
// }
```

- Whitespace-separated dot-paths (GraphQL-style, JS-native).
- `ref.field` traverses the reference; many-valued refs yield arrays of nested objects.
- Only traverses attributes whose values are `ref()` or whose schema says `db/ref`.
- Array form `['user.name', 'user.age']` accepted; object aliases are future work.

## datalog — canonical query engine

```ts
db.query({
  find: ['?e', '?name'],
  where: [
    ['?e', 'user/age', { $gt: 18 }],
    ['?e', 'user/name', '?name']
  ]
});
```

- `QuerySpec` remains the canonical read AST.
- Clauses accept the same operator objects as `find` (evaluated as a constrained step).
- Result rows stay `QueryTerm[][]`.

## Time travel

```ts
db.at(5).find({ 'user/role': 'admin' });  // rename of atTransaction(tx); alias kept
db.diff(3, 5);                            // { added: Fact[], retracted: Fact[] } between tx 3 and 5
```

- `diff` is the primitive for DevTools timeline, undo/redo, and audit rendering.

## Operator reference

| Operator | Semantics |
|---|---|
| `$eq` | equal (Object.is semantics for scalars) |
| `$ne` | not equal |
| `$gt` `$gte` `$lt` `$lte` | numeric / date / string ordering |
| `$in` / `$nin` | membership (scalar attributes) |
| `$exists` | attribute present (distinguishes null from missing) |
| `$contains` | any member of a many-valued attribute matches the operand |

## Open questions

1. Tagged-template query sugar (`db.query\`find ?e where …\``) — include in v1 or defer?
   *(Leaning: defer; the data-driven surface is the documented contract.)*
2. Accept `db/id` as an alias for `id` in maps? *(Leaning: yes, cheap compat.)*
3. Confirm the update verb set: `set` / `patch` / `retract` (drop `db.edit`).
4. `pull` object-form aliases (`{ friend: 'user.friend' }`) now or later?
