# 01 — Data Model: Values, Refs, Tempids, Schema, Entity State

Status: **Approved — not yet implemented.**

## Goal

Define the atomic unit of storage (facts), the set of supported values, how entities are
identified, how references are expressed, and what schema can express — in terms that are
natural for JavaScript/TypeScript developers and that keep the engine deterministic,
serializable, and DevTools-visible.

## Fact shape (unchanged)

```
[ eid, attribute, value, tx, op ]
```

| Field | Type | Notes |
|---|---|---|
| `eid` | `EntityId` | `number` \| `string` |
| `attribute` | `string` | namespaced (`user/name`) or plain |
| `value` | `Value` | see supported values below |
| `tx` | `number` | monotonic, engine-assigned |
| `op` | `'add' \| 'retract'` | append-only |

Append-only. Updates are represented as retract-old + add-new (in the same transaction for
the `set`/`patch` helpers).

## Supported values

| Value | Notes |
|---|---|
| `string` | indexed, queryable |
| `number` | indexed; `NaN`, `±Infinity` rejected at transaction time |
| `boolean` | indexed |
| `null` | explicit absence; `$exists` distinguishes null from missing |
| `Date` | indexed by ms epoch; wire form `{ "$date": ms }` |
| `BigInt` | wire form `{ "$bigint": "…" }` |
| `ref(value)` | entity reference (see below) |
| `temp()` | tempid handle usable as a value (see below) |

> **Opaque objects and arrays are NOT values.**
>
> - An object literal where a value is expected is interpreted as a **nested entity** (see
>   the transact grammar in [02-transact-and-query.md](./02-transact-and-query.md)).
> - An array is expanded into multiple cardinality-many facts (rejected if the attribute is
>   cardinality-one).
>
> Rationale: today `valueKey()` stringifies objects for the AVET index, but queries only
> match primitives — so object values are write-only noise. Making objects mean "entities"
> keeps the graph story coherent and makes `pull`/`ref` deterministic.

## References — `ref()`

```ts
const friend = ref(aliceId); // Symbol-branded { [REF_BRAND]: eid }
```

- `ref(eid)` accepts `number | string | temp-handle | lookupRef`.
- Resolves the ambiguity between `user/friend = 42` (a reference) and `user/age = 42` (a
  scalar). **A plain number is never a reference.**
- `ref()` values are the only way to store a reference to another entity.
- `lookupRef([attribute, value])` references an entity by a unique attribute — this is what
  enables `db/unique: 'identity'` upserts.
- Wire forms: `{ "$ref": eid }` / `{ "$lookupRef": [attribute, value] }`.

## Entity ids and tempids

- `EntityId = number | string`. String ids are stable across processes; prefer
  `crypto.randomUUID()` for generated string ids.
- **Tempid**: a negative number (`-1`) or a `temp()` handle used inside a transaction.
  All occurrences of the same tempid within one transaction resolve to the same
  engine-assigned id. Tempids never appear in committed facts.
- Schema attribute entities use negative ids internally (existing `nextSchemaEid` pattern);
  that is an implementation detail, not a public contract.

## Schema

Schema is data (facts on schema entities), extended beyond the current four attributes:

| Attribute | Type | Meaning |
|---|---|---|
| `db/ident` | `string` | attribute name |
| `db/valueType` | `string` | `string` \| `number` \| `boolean` \| `null` \| `date` \| `bigint` \| `ref` \| `unknown` |
| `db/cardinality` | `string` | `one` \| `many` |
| `db/unique` | `string` | `identity` (participates in upsert) \| `value` (hard unique constraint) — optional |
| `db/ref` | `boolean` | attribute values are references — optional; inferred from `valueType: 'ref'` |

Declared with object maps:

```ts
db.transact([
  { ident: 'user/email', valueType: 'string', cardinality: 'one', unique: 'identity' }
]);
```

## Entity state

- `entity(eid)` returns `{ id, ...attrs }`.
- Cardinality-many attributes are arrays in insertion order.
- Returned objects are **`Object.freeze`d** — immutability is enforced by the engine, not
  by convention. Consumers who need to mutate can `structuredClone` the result.
- Values of `ref`-typed attributes may be returned as `ref()` values when a flag is set
  (default: plain id, for ergonomics and JSON compatibility).

## Wire representation of values

JSON is the transport; lossy types are tagged so round-trips are stable:

| JS | JSON |
|---|---|
| `ref(id)` | `{ "$ref": id }` |
| `lookupRef([attr, value])` | `{ "$lookupRef": [attr, value] }` |
| `temp()` | never serialized (resolved before commit) |
| `Date` | `{ "$date": 1700000000000 }` |
| `BigInt` | `{ "$bigint": "9007199254740993" }` |
| everything else | plain JSON |

## Open questions

1. Should `db/ref` be explicit, or always inferred from `valueType: 'ref'`? *(Leaning:
   infer, allow explicit override.)*
2. The schema-designer currently emits relationship references with `valueType: 'number'`.
   Migration path for existing documents? *(Leaning: re-import with `ref` valueType; no
   implicit number-as-ref compat.)*
3. Always `Object.freeze` entity state, or make it opt-in? *(Leaning: always.)*
