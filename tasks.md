# Tasks

> Work items for the framework direction documented in
> [docs/framework-vision.md](./docs/framework-vision.md), plus the open library
> gaps from [docs/niche-gap-tasks.md](./docs/niche-gap-tasks.md).
>
> Priority legend: **P0** = decision blocker · **P1** = next / foundational ·
> **P2** = follows · **P3** = polish. Checkboxes are unchecked until the item's
> acceptance criteria pass.

## 0. Decisions to make first

- [ ] **D1 — Admin form factor.** React component library (embeddable in the
      user's own app) vs. a standalone hosted admin (Django-style). *Leaning:
      component library* — ships faster and matches "data layer over your web
      framework". Blocks W3.
- [ ] **D2 — Build order.** Admin-first demo vs. Postgres-first. *Leaning:
      admin-first demo on the existing in-memory engine + Postgres engine in
      parallel.* Blocks W1/W3 scheduling.

## 1. W1 — Postgres engine (server foundation)

- [ ] **W1.1 — Schema & DDL.** `facts`, `transactions`, and materialized
      current-state tables (cardinality-one unique indexes; EAVT/AEVT/AVET-shaped
      indexes) + idempotent migration DDL.
- [ ] **W1.2 — Tx-atomic append.** One Fatos transaction = one Postgres
      transaction: fact append + ledger row + index maintenance atomic.
- [ ] **W1.3 — Boot from current state.** Server seeds its hot in-memory cache
      from Postgres current-state (not a full log replay).
- [ ] **W1.4 — Time-travel reads.** `at(tx)` / `find(criteria, tx)` path over the
      fact log (`tx <= N`); decide SQL push-down vs. fetch-and-filter.
- [ ] **W1.5 — `LISTEN/NOTIFY` fan-out.** Multi-process servers share one
      Postgres and fan out changes — removes the single-process ceiling.
- [ ] **W1.6 — JSONB metadata.** Transaction metadata round-trips via wire tags
      in Postgres.
- [ ] **W1.7 — Rules via recursive CTEs.** Datalog rules/recursion on the server
      (see gap-analysis §4).
- [ ] **W1.8 — Row-level security.** Basic auth/RBAC/multi-tenancy via RLS
      (unblocks the audit/ops niche).
- [ ] **W1.9 — Retire the "any backend" promise.** Drop MongoDB; keep
      `MemoryAdapter` (tests), `FileAdapter` (dev), `IndexedDBAdapter` (browser
      cache). Update docs to say "Postgres-first".

## 2. W2 — DX core

- [ ] **W2.1 — Type codegen.** Schema → typed `Entity` / `Query` types generated
      from the code-authored schema.
- [ ] **W2.2 — Migrations.** Schema transactions + validation/backfill tooling
      ("does existing data satisfy the new constraint?").
- [ ] **W2.3 — Drift check.** Warn when the running schema has moved past the
      generated types.
- [ ] **W2.4 — Export-to-code round-trip.** Graduate the schema-designer
      import/export to write the current schema back to a code file.

## 3. W3 — Temporal admin (the wedge)

- [ ] **W3.1 — Auto CRUD scaffold.** List / detail / edit views generated from
      schema + entities (the `FatosAdmin` component library).
- [ ] **W3.2 — Time travel.** Scrub to any tx; every view is "as of tx N".
- [ ] **W3.3 — Per-field diff.** Show what changed between transactions.
- [ ] **W3.4 — Undo.** Apply the inverse of a transaction's diff; history kept.
- [ ] **W3.5 — Audit view.** The ledger as a UI: who changed what, when, metadata.
- [ ] **W3.6 — Schema tab.** Edit/add schema items from the admin itself.
- [ ] **W3.7 — Auth gating.** Basic admin auth/roles (ties to W1.8).

## 4. Cross-cutting / cleanup

- [ ] **X1 — Fix doc drift.** `docs/comparison-datomic-datascript.md` §2.1/§2.2/§6
      still says persistence adapters are a "stub" and that refs/upserts/operators/
      pull are unbuilt, and cites "~95 tests" — all now false (228 core tests,
      all adapters shipped). Reconcile with
      `docs/gap-analysis-query-schema-rules.md`.
- [ ] **X2 — Align guides.** Update `client-guide.md` / `react-guide.md` /
      root `README.md` with the framework positioning ("Postgres-first",
      "data layer + admin", not "database").

## 5. Carried-forward library gaps (from niche-gap-tasks.md)

Still-open items; details + acceptance live in
[docs/niche-gap-tasks.md](./docs/niche-gap-tasks.md). Device/edge items (G8–G10)
are de-emphasized under Postgres-first but remain valid library improvements.

- [x] **G1 (P1)** — client `find`/`at(tx)` expose `orderBy`/`limit`/`offset`/`select`.
- [ ] **G2 (P1)** — `entity()` returns `ref()` values as plain ids by default.
- [x] **G3 (P1)** — `SyncingClient` write-through (drop the per-app `api.ts`).
- [ ] **G4 (P2)** — `db.txAtOrBefore` / `atTime` ("state as of `<time>`").
- [ ] **G5 (P2)** — React as-of read (`useQuery(criteria, { asOf: tx })`).
- [ ] **G6 (P3)** — `db.transactionFacts(tx)` convenience.
- [ ] **G7 (P2)** — demo follow-ups: reference-app guide, AI-agent session
      recorder, FieldSync (see note below).
- [ ] **G8 (P1)** — syncing client derives watermark from a restored cache.
- [ ] **G9 (P2)** — `afterTime` on sync / `GET /facts?since=`.
- [ ] **G10 (P2)** — persist the syncing mirror via an injected adapter.

> **G7 note.** Under the framework direction, the *AI-agent session recorder* is
> the highest-value demo (temporal + replay + the hot 2026 market); FieldSync's
> device/edge thesis is now secondary to the Postgres-first story.

## 6. Definition of done (repo conventions)

- Package-scoped changes; `strict: true` / type-aware lint preserved.
- vitest tests added/updated with behavior changes (`npx vitest run`).
- Rebuild a package's `dist/` before type-checking/testing dependents.
- Log items in [issues.md](./issues.md) as `open` when work starts, flip to
  `fixed` with a `Resolution` once acceptance passes.
