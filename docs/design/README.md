# Design Documents — JS-Native Fatos API

Status: **Approved direction — not yet implemented.** This design is the contract that
implementation work (see [04-phasing.md](./04-phasing.md)) is built against.

The goal of this design series is to make Fatos feel native to JavaScript/TypeScript
rather than a transliteration of Datomic/Clojure idioms. The core rule that holds it
together:

> **Keep the engine data-driven; add JS-native ergonomics as layers of sugar that compile
> down to the same canonical shapes.**

- Every write form compiles to `Mutation[]` (`['add'|'retract', eid, attribute, value]`).
- Every read form compiles to `QuerySpec` (`{ find, where }`) or a pull path.
- Sugar never bypasses the fact log.

This keeps the system deterministic, serializable, time-travelable, and inspectable in
DevTools — the properties that justify the whole project.

## Documents

| Doc | Covers | Status |
|---|---|---|
| [01-data-model.md](./01-data-model.md) | Fact shape, supported values, `ref()`/`temp()`, schema, entity state, wire tags | Approved |
| [02-transact-and-query.md](./02-transact-and-query.md) | `insert`/`upsert`/`set`/`patch`, nested graph flattening, `find` operators, `pull`, datalog, time travel | Approved |
| [03-reactivity-and-wire.md](./03-reactivity-and-wire.md) | Access-tracking live queries, `EventTarget` client, async iterables, React hooks, REST/WS protocol | Approved |
| [04-phasing.md](./04-phasing.md) | Ordered implementation phases (P0–P4) with acceptance criteria | Approved |

## Cross-cutting decisions (agreed)

1. **Opaque object values are rejected.** Object literals in transactions mean *nested
   entities*; arrays expand to cardinality-many facts. This removes the current
   "stored but unqueryable" object-value dead end.
2. **Primary authoring verbs are `insert` / `upsert` / `set` / `patch`.** `add` /
   `retract` / `transact` remain as the low-level surface.
3. **References are first-class via `ref()`** — a plain number is a scalar, never a
   reference.
4. **Reactivity is dependency-based.** A reactive read re-evaluates only when facts
   relevant to it change, not on every transaction.

## Next-phase direction

The framework pivot (Django-style data framework, temporal admin, Postgres
backend) is documented in [framework-vision.md](../framework-vision.md). It
extends this API series and supersedes the storage-flexibility decision in
[04-phasing.md](./04-phasing.md).
