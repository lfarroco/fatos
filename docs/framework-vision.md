# Framework Vision — Fatos as a fullstack data framework

> **Status: Proposed direction (2026-08-16).** This document records the
> strategic pivot agreed after the niche-validation work
> ([niche-validation.md](./niche-validation.md)) and the positioning analysis of
> the same date. It supersedes the roadmap tail of [PLAN.md](../PLAN.md) and the
> storage-flexibility decision in [04-phasing.md](./design/04-phasing.md).

## 1. Positioning

**Fatos is a fullstack *data* framework in the Django mold — models, migrations,
auth, and an auto-generated admin — but temporal, and for the modern TypeScript
stack.** The developer's database (Postgres) is the durable substrate; Fatos owns
the fact model, the query language, sync, and the DX layer on top of it.

What Fatos is *not*:

| Not this | Why |
|---|---|
| A web framework (routing, templates, rendering) | You bring Next.js / Remix / Express; competing there loses. |
| A database | The engine is in-memory; Postgres is the source of truth. Fatos sells the DX + temporal layer, not storage. |
| A storage-agnostic adapter zoo | Postgres is the production backend (see §5). |

One-liner:

> Fatos is the Django-style data layer for TypeScript apps — a temporal,
> schema-driven admin and sync engine over Postgres — where every change is
> reversible and auditable by default.

## 2. Why this direction

Three reasons, each reinforcing the others:

1. **Django's admin is its killer feature — and Fatos's is strictly better.**
   Django auto-generates a CRUD UI from models. Fatos auto-generates a CRUD UI
   that is *temporal*: time-travel scrubber, per-field diff, undo-that-
   preserves-history, and an audit view — all free consequences of the fact
   model. Django's admin has none of this (hence `django-reversion`). This is
   the wedge (§3).
2. **Schema-as-data is the deepest differentiator.** Schema is facts, so the
   schema itself is transactional, time-travelable, syncable, and auditable —
   editable from the admin (§4). Django's schema is code.
3. **Postgres lock-in trades breadth for depth.** One real storage backend buys
   ACID, `LISTEN/NOTIFY` scale-out, recursive CTEs (rules/recursion), row-level
   security (auth), JSONB, and PITR — things the snapshot-blob adapters can
   never provide (§5).

## 3. The temporal admin (the wedge)

Auto-generate list / detail / edit views from schema + entities, with:

- **Time travel** — scrub to any tx; every view is "as of tx N".
- **Diff** — per-field change between transactions.
- **Undo** — apply the inverse of a transaction's diff; history is kept, not erased.
- **Audit view** — the ledger as a UI: who changed what, when, with what metadata.
- **Schema tab** — edit/add schema items from the admin itself (the
  `@fatos/schema-designer` graduated from DevTools toy to framework feature).

The admin is the first thing to demo: *add an attribute in the admin, watch it
propagate to every connected client, then time-travel the schema itself.*

## 4. Schema-as-data and the code/store authority

Schema is facts (`db/ident`, `db/valueType`, `db/cardinality`, `db/unique`,
`db/ref`). Consequences:

- Schema changes are **transactions** — atomic, synced to clients, recorded in
  the ledger with actor metadata.
- Schema is **time-travelable** — `at(tx)` answers "what was the schema last
  Tuesday".
- Schema changes are **auditable** — the ledger is the schema's change history.

**Authority split** (the one design decision this forces):

| Source | Role |
|---|---|
| Code (`schema.ts` / seed) | Source of truth for generation + code review; feeds the type codegen |
| Store (facts) | Source of truth at runtime |
| Admin + export round-trip | Bridge — "export schema to code" writes the current schema back to the file |
| Drift check | Safety net — warn when the running schema has moved past the generated types |

**Migrations** become schema transactions plus a validation/backfill step ("does
existing data satisfy the new cardinality/valueType?"), not migration files. The
engine already validates on write; the remaining work is the check-and-backfill
operation.

**Codegen:** schema → typed `Entity` / `Query` types, generated at build time
from the code-authored schema. Runtime edits invalidate them → the drift check
is the guardrail.

## 5. Postgres as the server foundation

The server's source of truth, transaction authority, and change bus become
Postgres:

- **Facts / transactions / current-state tables.** The append-only fact log
  lives in a `facts` table; the ledger in `transactions`; materialized
  current-state (cardinality-one unique indexes, EAVT/AEVT/AVET-shaped indexes)
  serves reads without loading the whole log into memory.
- **One Fatos transaction = one Postgres transaction.** Fact append + ledger +
  index maintenance are atomic. WAL, PITR, backups, and replication come free.
- **`LISTEN/NOTIFY` fan-out.** Multiple Fatos server processes share one
  Postgres and fan out changes to clients — removing the single-process
  in-memory ceiling.
- **Recursive CTEs** give a real path to the Datalog rules/recursion that
  [gap-analysis](./gap-analysis-query-schema-rules.md) marks as unbuilt.
- **Row-level security** unblocks the auth/multi-tenancy the audit/ops niche needs.
- **JSONB** for transaction metadata.

**What stays / what goes:**

| Adapter | Fate |
|---|---|
| In-memory engine (browser + server) | Stays — the client's engine and the server's hot cache |
| `IndexedDBAdapter` | Stays — the browser's durable local cache |
| `MemoryAdapter` | Stays — tests |
| `FileAdapter` | Stays — zero-setup local dev |
| Postgres (real engine) | **Becomes the production backend** |
| MongoDB / "any backend" | **Retired** — breadth bought no depth |

> **This reverses design/04's multi-adapter flexibility.** The honest rationale:
> "flexibility won a broad-but-shallow storage story; Postgres wins ACID,
> scale-out, RLS, and recursion."

The "one engine, two runtimes" property survives as **"one fact model and one
query language, two runtimes — Postgres-backed on the server, an in-memory
slice on the client"** (Datomic's peers/transactor shape).

## 6. Workstreams & phasing

| # | Workstream | What | Depends on |
|---|---|---|---|
| W1 | Postgres engine | Facts/ledger/current-state schema, tx-atomic append, time-travel queries, `LISTEN/NOTIFY` fan-out | — |
| W2 | DX core | Schema → type codegen; migration/backfill tooling; drift check | W1 |
| W3 | Temporal admin | Auto CRUD + time travel + diff + undo + audit + schema tab | W2 |

**Recommended order:** build **W3 first on the existing in-memory engine** to
get a demo-able wedge in weeks, with **W1 in parallel** — the admin demo works
today and wins users; the Postgres engine makes it production-ready.

## 7. Open decisions

1. **Admin form factor.** React component library (embeddable in the user's own
   app) vs. a standalone hosted admin (Django-style). *Leaning: component
   library first — ships faster and matches "data layer over your web
   framework".*
2. **Admin-first vs. Postgres-first.** *Leaning: admin-first demo + Postgres in
   parallel* (see §6).

## 8. Non-goals (reaffirmed / changed)

- No routing / templates / rendering — the web layer is the user's choice.
- No offline-first multi-writer / CRDT (unchanged from PLAN.md).
- No multi-DB support — **Postgres-first** (changed from design/04).
- No "complex" authorization — basic auth/RBAC via Postgres RLS is in scope;
  fine-grained custom policy engines remain out.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Scope creep into a full web framework | Anchor to "data layer + admin"; explicitly reuse Next/Remix/Express |
| Postgres engine is a large lift | Phase it: storage + tx atomicity first, LISTEN/NOTIFY and CTEs later |
| Runtime schema edits vs. generated types drift | Code-as-truth for generation; drift check; export round-trip |
| Losing the "one engine, two runtimes" property | Keep the in-memory engine as the client runtime; Postgres only server-side |
