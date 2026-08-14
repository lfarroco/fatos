# Fatos vs. Datomic vs. DataScript

> **Status snapshot: August 2026.** Fatos is early-stage and evolving quickly. This document
> captures the state of the codebase and its approved design at the time of writing. The
> live source of truth is [PLAN.md](../PLAN.md) and the [design series](./design/README.md).

## 1. Purpose

This document compares what the **Fatos** project offers against the two systems that
inspired it: **Datomic** (production distributed database) and **DataScript** (in-memory
Datalog database). It is written as a durable reference for design decisions and
prioritization — not a marketing comparison.

For the concrete, itemized work needed to close feature gaps in querying, schema, and
rules, see [gap-analysis-query-schema-rules.md](./gap-analysis-query-schema-rules.md).

## 2. What Fatos is today

Fatos is a TypeScript monorepo implementing an EAV-style temporal fact store:

- Facts: `[eid, attribute, value, tx, op]`, append-only, operation stored in-tuple
- Transactions with monotonic tx ids and metadata
- EAVT / AEVT / AVET indexes (maintained on write; reads currently full-scan)
- `entity(eid, tx)`, `find(criteria, tx)`, Datalog-style `query({ find, where }, tx)`
- `atTransaction(tx)` time travel
- Schema as facts: `db/ident`, `db/valueType` (`string | number | boolean | null | unknown`),
  `db/cardinality` (`one | many`), with valueType and cardinality validation
- Client: in-memory browser client with `subscribe` / `observe*` reactivity
- React: `FatosProvider`, `useQuery`, `useDatalogQuery`, `useEntity`, `useTransaction`
- Server: Node HTTP (facts, transact, transactions, SSE events, entity) + WebSocket fan-out
- DevTools: page ↔ extension postMessage bridge; schema-designer document model + React canvas
- ~95 tests green, all packages build, MIT license

**Critical caveat:** the project has an *approved-but-unbuilt* design layer
([`docs/design/01–04`](./design/README.md)) describing the intended API — `insert` /
`upsert` / `set` / `patch`, `pull`, find operators, `ref()` / `temp()`, `db/unique` /
`db/ref`, live queries, and more. **None of that is implemented yet.** Any comparison must
distinguish "what works today" from "what the design promises."

### 2.1 Implemented today

| Area | Status |
|---|---|
| Fact storage, transactions, tx metadata | ✅ |
| EAVT / AEVT / AVET indexes | ✅ written, but reads full-scan (P0 to fix) |
| Datalog subset (`{ find, where }` equi-joins) | ✅ |
| `entity` / `find` / `atTransaction` | ✅ |
| Schema: ident, valueType (4 types), cardinality | ✅ (known same-tx validation bug) |
| Client reactivity (`subscribe`, `observe*`) | ✅ (coarse: every write notifies all listeners) |
| React hooks | ✅ |
| Server REST + WebSocket | ✅ (in-memory only) |
| Persistence adapters | ❌ stub |
| Full Datalog / pull / operators / rules | ❌ |
| `ref()` / `temp()` / upserts / `db/unique` | ❌ |

### 2.2 Designed but not built (approved in `docs/design/01–04`)

- `insert` / `upsert` / `set` / `patch`, nested-object graph flattening, tempids
- `ref()` / `lookupRef()` references, `Date` / `BigInt` values, wire type tags
- `find` operators, `pull` dot-paths, `db.diff`, `db.at`
- `db/unique`, `db/ref` schema attributes
- Access-tracking live queries, EventTarget client, async iterables
- Index-based reads with P0 benchmark targets (10k entities: ingest < 200 ms,
  single-clause query < 10 ms, 2-clause join < 50 ms)

## 3. Positioning at a glance

| | Fatos | Datomic | DataScript |
|---|---|---|---|
| Nature | Full-stack TS temporal fact DB (early) | Production distributed DB | In-memory Datalog DB |
| Runtime | Browser + Node.js (TypeScript) | JVM/Clojure + storage service | Clojure / ClojureScript |
| Persistence | None yet (planned) | Durable (DynamoDB, SQL, Cassandra, Cloud) | None (opt-in serialization/storage) |
| Server / multi-client | Lightweight Node server + WebSocket | Yes (transactor + peers, ACID) | No |
| License | MIT | Proprietary (Cognitect/Nubank) | EPL |

## 4. Feature comparison

| Capability | Fatos | Datomic | DataScript |
|---|---|---|---|
| Fact model | `[eid, attr, value, tx, op]` (op in tuple) | datoms `[e a v tx]` + `:added` | datoms `[e a v tx]` + `:added` |
| Entity ids | **number or string** | integers + lookup refs | integers + lookup refs |
| Indexes | EAVT/AEVT/AVET (reads full-scan today) | EAVT/AEVT/AVET/VAET, storage-backed, full history | EAVT/AEVT/AVET, persistent sorted sets |
| Query | `{ find, where }` equi-joins only | Full Datalog: rules, aggregates, negation, or-join, predicates, pull | Full Datomic-style Datalog + pull |
| Return shapes | `QueryTerm[][]` rows | rel / coll / scalar / tuple finds, return maps (`:keys`/`:strs`/`:syms`) | rel / coll / scalar / tuple finds, return maps |
| Schema | ident, valueType (4), cardinality | 13 value types, unique, index, fulltext, component, noHistory, tuples, preds | simplified: valueType, cardinality, unique, index, component, doc, tuples |
| Refs | plain numbers only (`ref()` planned) | first-class refs, components, graph traversal | first-class refs, components |
| Time travel | `atTransaction(tx)` | `as-of`, `since`, tx-as-entity, `with` | `as-of`, `since` (with history) |
| Upserts / tempids | planned | identity upserts, `:db/id`, tx functions | identity upserts, tempids |
| Reactivity | coarse subscribe/observe; fine-grained planned | `tx-report-queue` only | `listen!` / `listen` |
| React bindings | first-party hooks | none | via re-frame (ClojureScript) |
| DevTools | Chrome extension + schema designer (in progress) | REPL tooling, Cloud console | none |
| Concurrency | single-process, in-memory | single-writer transactor, ACID, distributed reads | single-process, in-memory |
| Durability | none yet | durable log + pluggable storage | none (opt-in) |
| Maturity | early (v0.0.1, ~95 tests) | ~13 years, production | ~12 years, stable, widely used |
| Ecosystem | none yet | Clojure/JVM, books, community | ClojureScript, re-frame |

## 5. Advantages of Fatos vs. Datomic

1. **TypeScript-native, zero infrastructure.** No JVM, no transactor, no storage service.
   `createClient()` works in a browser tab; the same model runs in Node.
2. **Open source (MIT).** Datomic is proprietary with commercial licensing for production.
3. **Client-side operation.** Facts live in-process: instant reads, offline-capable.
   Datomic peers still depend on a server/storage.
4. **Reactive queries and React hooks.** Datomic has no reactive query story; Fatos's
   `observe*` (and planned live queries) go beyond Datomic's `tx-report-queue`.
5. **DevTools extension + schema designer.** A browser fact inspector with timeline/diff
   views is unique in this space.
6. **Lower learning curve for JS developers.** Data-driven query objects, tuple sugar,
   planned object-map inserts, rather than Clojure/EDN.
7. **String entity ids.** Natural for web apps already using UUIDs; Datomic/DataScript are
   integer-keyed.

## 6. Advantages of Fatos vs. DataScript

1. **Native TypeScript/JavaScript API.** No ClojureScript toolchain; typed npm packages.
   This is the biggest practical win — DataScript's surface is Clojure-only.
2. **Server + sync + persistence roadmap.** DataScript is strictly in-memory and
   single-process; Fatos ships a Node server with REST/WS and plans storage adapters.
3. **First-party React bindings.** `@fatos/react` is typed and in-repo, versus DataScript's
   third-party re-frame glue.
4. **DevTools extension and visual schema designer.** DataScript has neither.
5. **Strict typing end-to-end.** `Fact`, `QuerySpec`, `TransactionEntry` and friends are
   typed.

## 7. Downsides and limitations

1. **Immaturity.** v0.0.1; the approved design is not yet the shipped API. No production
   usage, small ecosystem, APIs subject to change.
2. **Query power far below both.** Today only equi-joins; no rules, aggregates, negation,
   disjunction, predicates, or pull. DataScript and Datomic ship full Datalog.
3. **No persistence.** `@fatos/persistence` is a stub; data is lost on process exit.
   Datomic is durable by design.
4. **Performance not production-grade.** Reads full-scan the fact array; the project's own
   P0 doc cites ~7 s for a 2-clause join over 10k entities (targets 10–50 ms).
5. **No entity references yet.** Plain numbers cannot express graph relationships;
   `ref()`, lookup refs, `db/unique`, `db/ref` are all still planned.
6. **Coarse reactivity today.** Every write notifies every listener; React hooks re-render
   on any transaction (design/03 acknowledges and plans to fix this).
7. **No distributed/ACID/multi-process guarantees.** Explicit non-goals: distributed
   replication, CRDT offline sync, complex authz, full-text search, sharding.
8. **Thinner value model.** No Date/BigInt/uuid/uri yet (Date/BigInt planned); opaque
   object values are "stored but unqueryable" today, which design/01 plans to reject.
9. **No community or track record.** Datomic and DataScript have years of docs, books,
   answers, and battle-tested edge cases.

## 8. Bottom line

Fatos is best understood as **"DataScript's niche (in-browser temporal Datalog DB) plus
Datomic's server layer, rebuilt as a modern TypeScript/React product with DevTools."** It
is not currently a Datomic competitor on durability, scale, or query power, and it does
not yet match DataScript on query completeness or stability.

Its genuine differentiators are the DX layer: **TypeScript-first full-stack** (one
language, one fact model from React component to Node server), **first-party typed React
integration with reactive queries**, and **browser DevTools + schema designer**. Whether
it overtakes DataScript depends on delivering P0–P4 (index-based reads, refs/tempids/
upserts, live queries, persistence) — the areas where it currently loses on substance
rather than packaging.


