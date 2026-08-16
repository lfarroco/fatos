# Gap Analysis — Reaching Datomic/DataScript in Querying, Schema, and Rules

> **Purpose.** An itemized, prioritized ledger of what Fatos needs to reach
> Datomic/DataScript feature parity in the three named areas. The target is **not** literal
> EDN/keyword parity — it is Datomic/DataScript *feature surface re-expressed as Fatos's
> JS-native, data-driven shapes* (per [`docs/design/README.md`](./design/README.md):
> "sugar compiles down to the same canonical shapes").
>
> Companion document: [comparison-datomic-datascript.md](./comparison-datomic-datascript.md).

## Status flags

- ✅ implemented in Fatos today
- 📋 already designed ([`docs/design/01–04`](./design/README.md), `PLAN.md` P0–P4) — not yet built
- ❌ missing / not planned anywhere

## Sources

- Datomic Query Reference — `docs.datomic.com/pro/query/query-data-reference.html`
- Datomic Schema Reference — `docs.datomic.com/pro/schema/schema.html`
- DataScript README + source — `github.com/tonsky/datascript`
- Fatos `PLAN.md` and `docs/design/01–04`

## 1. Current Fatos query surface (baseline)

- `find(criteria, tx)` — exact `Object.is` match on scalar attributes; **known
  limitation: never matches many-valued attributes** (pinned in `query.test.ts`).
- `query({ find, where }, tx)` — Datalog subset: `where` clauses are 3-tuples
  `[e, a, v]`; terms are `?vars`, constants, or entity ids; evaluated as nested-loop
  joins over materialized triples; result rows are `QueryTerm[][]`, deduplicated.
- `atTransaction(tx)` — scopes `entity` / `find` / `query` to a tx.
- No parameters, no predicate/function clauses, no `not` / `or`, no rules, no
  aggregates, no pull, no operators, no ordering/paging.

## 2. Querying gaps

### 2.1 Designed and implemented (✅)

All items below were specified in design/02 and are implemented in `@fatos/core`
as of 2026-08.

| Gap | Where | Notes |
|---|---|---|
| ✅ `find` operators `$eq $ne $gt $gte $lt $lte $in $nin $exists $contains` | design/02 §"find" | single evaluation engine (`operatorMatchesValue`, cardinality-many aware) |
| ✅ `orderBy`, `limit`, `offset`, `select` | design/02 §"find" | `FindOptions` |
| ✅ `pull` dot-paths with ref traversal | design/02 §"pull" | `db.pull(eid, paths)` |
| ✅ `db.at(tx)` rename; `db.diff(txA, txB)` | design/02 §"time travel" | `atTransaction` kept as alias |

### 2.2 Find-layer gaps (❌ unless noted)

| Gap | Status | Priority |
|---|---|---|
| ✅ Operators (2.1) | ✅ | P1 — high (done) |
| ✅ `orderBy` / `limit` / `offset` / `select` | ✅ | P1 — high (done) |
| ✅ `$contains` on many-valued attributes | ✅ | P1 — high (fixes the P0 array-find limitation) |
| ✅ `$exists` distinguishing null from missing | ✅ | P1 — high (done) |
| ✅ `find` matches many-valued attributes | ✅ | P1 — high (done) |

### 2.3 Datalog find-shape gaps (❌)

Datomic/DataScript support four find shapes plus return maps; Fatos only returns
rel-style rows.

| Feature | Datomic/DataScript | Fatos |
|---|---|---|
| find-rel (`?a ?b …`) | ✅ | ✅ (only shape today) |
| find-coll (`[?a …]`) | ✅ | ❌ |
| find-scalar (`?a .`) | ✅ | ❌ |
| find-tuple (`[?a ?b]`) | ✅ | ❌ |
| `distinct` | ✅ | ❌ (dedup is implicit today) |
| return maps `:keys` / `:strs` / `:syms` | ✅ | ❌ |
| `with` clause (extra grouping vars for aggregates) | ✅ | ❌ |

**Recommendation:** add find shapes, `distinct`, and return-map options as a later
surface pass (P3), after operators and pull land.

### 2.4 Where-clause gaps (❌)

| Feature | Semantics | Priority |
|---|---|---|
| Predicate clauses `[(fn args)]` | filter bindings through a JS predicate | P3 |
| Function clauses `[(fn args) result]` | bind the result of a JS function to a var | P3 |
| `(not [clauses])` | negation of a pattern conjunction | P3 — high |
| `(not-join [vars] [clauses])` | scoped negation | P3 — low |
| `(or [clauses] …)` | disjunction | P3 — high |
| `(or-join [vars] [clauses] …)` | scoped disjunction | P3 — low |
| `tuple` / `untuple` helpers | build / destructure tuple values | P4 |

### 2.5 `:in` binding gaps (❌)

Datomic/DataScript parameterize queries with `:in`; Fatos has no input parameters.

| Binding form | Semantics |
|---|---|
| scalar (`?x`) | single value |
| collection (`?xs …` / `[?xs …]`) | bind a collection as one var |
| tuple (`[?a ?b]`) | destructure a vector |
| relation (`[[?a ?b]]`) | bind a collection of tuples |
| db source (`$` / `$name`) | query over multiple DB/collection sources |
| rules (`%`) | rule database |

**Recommendation (P3):** add `params` / `inputs` to `QuerySpec` with JS-native
equivalents (`inputs: […]` or `params: {…}`), then `sources: { name: db }` and
relation binding as follow-ups.

### 2.6 Aggregates (❌)

Datomic built-ins: `count, sum, min, max, avg, median, variance, stddev, distinct,
rand, sample`. DataScript supports the standard set plus custom aggregate functions.

**Recommendation (P3):** `find` entries such as `['count', '?e']` or
`{ fn: 'count', arg: '?e' }`; group by the remaining non-aggregate find vars; ship
`count` / `sum` / `min` / `max` / `avg` / `distinct` first.

### 2.7 Query over collections / multiple sources (❌)

Datomic and DataScript can query over plain collections and multiple DB values. Fatos
queries are bound to a single database. Out of near-term scope; note as future work.

## 3. Schema gaps

### 3.1 Value types

| Value type | Datomic | DataScript | Fatos |
|---|---|---|---|
| `string` | ✅ | ✅ | ✅ |
| `number` / long / double / float | ✅ (distinct types) | ✅ (`number`) | ✅ (`number`) |
| `boolean` | ✅ | ✅ | ✅ |
| `null` | — (nil is absence) | — | ✅ (explicit `null` valueType) |
| `ref` | ✅ | ✅ | ✅ (`ref()`, design/01) |
| `instant` / `date` | ✅ | ✅ | ✅ (`Date`, design/01) |
| `bigint` | ✅ | ✅ | ✅ (design/01) |
| `uuid` | ✅ | ✅ | ❌ |
| `uri` | ✅ | ✅ | ❌ |
| `keyword` / `symbol` | ✅ | ✅ | ❌ (attributes are strings in Fatos) |
| `bytes` | ✅ (deprecated) | ❌ | ❌ (recommend never) |
| `tuple` | ✅ | ✅ (via `:db/tupleType` etc.) | ❌ |

### 3.2 Schema attributes

| Attribute | Datomic | DataScript | Fatos |
|---|---|---|---|
| `db/ident` | ✅ | ✅ (keywords are attrs; implicit unique) | ✅ |
| `db/valueType` | ✅ | ✅ | ✅ |
| `db/cardinality` | ✅ | ✅ | ✅ |
| `db/unique` (`identity` / `value`) | ✅ | ✅ | ✅ (design/01–02; `unique: 'identity'` upserts + `unique: 'value'` constraint) |
| `db/ref` | ✅ | ✅ | ✅ (design/01; ref schema attributes / `ref()` values) |
| `db/doc` | ✅ | ✅ | ❌ (cheap; recommend adding) |
| `db/index` (opt-in) | ✅ (legacy — all attrs indexed now) | ✅ | N/A — Fatos indexes all attributes |
| `db/fulltext` | ✅ | ❌ | ❌ (non-goal) |
| `db/isComponent` | ✅ | ✅ | ❌ |
| `db/noHistory` | ✅ | ❌ | ❌ (non-goal; Fatos is temporal by design) |
| `db/tupleType` / `db/tupleAttrs` | ✅ | ✅ | ❌ |
| `db.attr/preds`, `db.entity/attrs`, `db.entity/preds` | ✅ | ❌ | ❌ (recommend out of scope) |

### 3.3 Identity, refs, upserts

| Feature | Status | Notes |
|---|---|---|
| lookup refs `[attr, value]` | ✅ | design/01; `lookupRef()`, requires `db/unique` |
| upsert by identity | ✅ | design/02 §"explicit refs & upserts"; `db.upsert()` |
| tempid resolution (`temp()`, negative ids) | ✅ | design/01–02 |
| `retractEntity` (whole-entity delete) | ❌ | recommend adding with P1 |
| component cascade delete | ❌ | depends on `db/isComponent`; defer |
| uniqueness enforcement (`unique: 'value'`) | ✅ | P1; `uniqueIndex` constraint check on commit |
| ref integrity (ref points to an existing entity) | ❌ | with `db/ref`; not enforced yet |
| same-tx schema validation | ❌ bug | P0 — declared-and-written-in-one-tx attributes bypass valueType checks (pinned in `schema.test.ts`) |

### 3.4 Enforcement correctness

- valueType enforcement: ✅ (but same-tx bug above)
- cardinality one/many: ✅
- cardinality-one conflict rejection: ✅
- unique: ✅ (`unique: 'value'` constraint check on commit)
- ref existence: ❌ (not enforced yet)

## 4. Rules

### 4.1 What Datomic/DataScript provide

Rules are named, reusable, possibly **recursive** logic predicates used inside `:where`:

```clojure
;; Datomic / DataScript
[[(ancestor ?a ?d) [?a :parent ?d]]
 [(ancestor ?a ?d) [?a :parent ?mid] (ancestor ?mid ?d)]]
```

- A rule is a set of clauses, which may themselves be data clauses, expression clauses,
  or other rule invocations.
- Multiple definitions of the same rule name = logical OR.
- **Required bindings**: `(rule [?x] …)` — a rule only fires when the listed vars are
  already bound (Datomic reports an insufficient-binding anomaly otherwise).
- **Rule databases** (`%`) are passed via `:in`; rules can be scoped to a specific source
  (`($src rule args)`).
- DataScript supports recursive rules, rules over collections, and the same general
  semantics.

### 4.2 Fatos status

❌ **Nothing.** Rules do not exist today and are not mentioned anywhere in
`docs/design/01–04`. This is the single biggest missing *conceptual* feature for query
parity.

### 4.3 Proposed design (JS-native shape)

```ts
const rules = [
  { name: 'ancestor', args: ['?a', '?d'],
    body: [['?a', 'parent', '?d']] },
  { name: 'ancestor', args: ['?a', '?d'],
    body: [['?a', 'parent', '?mid'], ['ancestor', '?mid', '?d']] }
];

db.query({
  find: ['?a', '?d'],
  rules,
  where: [['ancestor', '?a', '?d']]
});
```

Design decisions to make:

- **Representation**: `rules?: Rule[]` on `QuerySpec`; `where` entries shaped as
  `[name, ...args]` (non-3-element tuples) dispatch to rules.
- **Required bindings**: optional `requires?: string[]` on a rule, enforced at binding
  time (Datomic-compatible semantics).
- **Recursion**: requires **fixpoint evaluation with memoization** per
  `(rule, bound-args)` — the current nested-loop join cannot express this. This is an
  engine change, not a sugar change.
- **Multiple definitions = OR**: same name/arity definitions union their results.
- **Rule bodies**: start with data clauses only; add expression clauses at P4.

### 4.4 Effort and phasing

| Milestone | Scope | Phase |
|---|---|---|
| Non-recursive rules | `rules` in `QuerySpec`, dispatch, OR-definitions, required bindings | P3 (after operators/pull) |
| Recursive rules | fixpoint evaluation + memoization | P4 |
| Rules over sources / collections | src-var scoping | P4 (optional) |

## 5. Priority-ordered roadmap

| Phase | Theme | Closes |
|---|---|---|
| **P0** | index-based reads; value model plumbing (`Date`, `BigInt`, refs); reject opaque objects; fix same-tx schema validation | performance + engine correctness |
| **P1** | find operators; `orderBy`/`limit`/`offset`/`select`; `pull`; `db/unique` + `db/ref`; tempids/upserts; `retractEntity`; `db/doc` | bulk of query/schema gaps |
| **P3** | `not` / `or`; predicate and function clauses; `:in`/params; aggregates; non-recursive rules; find shapes + return maps | Datalog completeness |
| **P4** | recursive rules; `not-join` / `or-join`; multi-source querying; `tuple` / `untuple` | deep parity |

## 6. Deliberate non-goals (won't match)

- **Full-text search** (`db/fulltext`) — Fatos non-goal (PLAN.md).
- **Partitions / sharding** — Fatos non-goal (PLAN.md).
- **Transaction functions** (`:db.fn/call`) — out of scope for a client-first engine.
- **Entity specs / attr & entity predicates** (`db.attr/preds`, `db.entity/preds`) —
  Datomic-only advanced features; defer indefinitely.
- **`bytes` value type** — deprecated even in Datomic; skip.
- **`db/noHistory`** — contrary to Fatos's temporal-by-design core.
- **Literal EDN/keyword syntax** — Fatos targets JS-native shapes.



