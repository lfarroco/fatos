# AGENTS

## Project

Fatos is a TypeScript monorepo for a temporal fact database that stores immutable facts and transaction history.

Primary goals:
- Temporal, append-only data model (facts are `[eid, attribute, value, tx, op]`, never mutated)
- Deterministic queries and indexing (EAVT / AEVT / AVET indexes, Datalog-style queries)
- Full-stack usage (browser + Node.js server)
- Strong developer tooling (DevTools, chrome extension, examples, schema designer)

**The same engine runs in the browser and on the server** — `@fatos/core` is the shared
core, `@fatos/client` wraps it for the browser, `@fatos/server` wraps it for Node. This
sharing is a deliberate design goal: keep `@fatos/core` environment-agnostic (it imports
nothing — no `node:*`, `ws`, `fs`, or DOM APIs) and never diverge the two runtimes.

## Monorepo Packages

- `packages/core`: shared database engine — facts, transactions, EAVT/AEVT/AVET indexes, Datalog query execution, live queries, schema. Runs in browser + Node; keep it environment-agnostic.
- `packages/client`: browser-facing client API (`FatosClient extends EventTarget`, reactive `observe*`, WebSocket sync via `sync.ts`).
- `packages/server`: Node.js server — HTTP API, WebSocket fan-out, synchronization, persistence wiring.
- `packages/persistence`: storage adapters implementing the `StorageAdapter` contract — file (snapshot + append log), postgres, mongodb, indexeddb, memory. `save()` writes a full snapshot; `append()` is the O(transaction) fast path.
- `packages/react`: React bindings and hooks (`FatosProvider`, `useQuery`, `useDatalogQuery`, `useEntity`, `useTransaction`).
- `packages/devtools`: inspection tooling — panel controller, graph layout, render, transforms, snapshot, export/import.
- `packages/chrome-extension`: browser extension integration (page ↔ panel bridge).
- `packages/schema-designer`: visual schema modeler — JSON document model, import/export adapters, React canvas.
- `packages/examples`: usage samples and integration examples (per-feature demos in `src/*.ts`).

## Source Of Truth For Work

Use [PLAN.md](PLAN.md) as the authoritative source for:
- Roadmap and phase ordering
- Current and upcoming tasks
- Priorities and implementation scope

When deciding what to build next, always align with the Development Priorities and phase
checklist in [PLAN.md](PLAN.md). Code comments reference the design series by number
(e.g. "design/03"); read the referenced doc before changing that code:

- [docs/design/](docs/design/README.md) — the design series: 01 data model, 02 transact/query, 03 reactivity/wire protocol, 04 phasing/persistence, 05 interned keys.
- [docs/performance-bottlenecks.md](docs/performance-bottlenecks.md) — server-side bottleneck list (B1–B3 fixed, B4 deferred).
- [docs/sync-strategies.md](docs/sync-strategies.md), [docs/client-guide.md](docs/client-guide.md), [docs/react-guide.md](docs/react-guide.md) — behavioral guides.
- [docs/comparison-datomic-datascript.md](docs/comparison-datomic-datascript.md), [docs/gap-analysis-query-schema-rules.md](docs/gap-analysis-query-schema-rules.md) — positioning and known gaps.

If roadmap guidance is ambiguous, follow [PLAN.md](PLAN.md) first, then README context.

## Working Guidance For Agents

- Keep changes focused and package-scoped when possible; preserve package boundaries (each package has its own `tsconfig.json`, build, and tests).
- Preserve TypeScript strictness (`strict: true`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`). Lint is type-aware (`@typescript-eslint` strict rules), so keep types precise.
- Add or update tests with behavior changes (vitest, per package).
- Prefer incremental, phase-aligned work over broad refactors.
- `@fatos/core` is shared by browser and server: never add Node-only or browser-only imports there.

## Commands

Run from the repo root. **The repo's `npm run test` scripts run vitest in watch mode and
hang in non-interactive shells** — use `npx vitest run` for a one-shot test pass.

| Task | Command |
|---|---|
| Tests (one-shot) | `npx vitest run` from a package dir, or `npx vitest run packages/core` from the root |
| Tests (watch) | `npm run test --workspace @fatos/core` |
| Type-check | `npm run types --workspace @fatos/core` or `npx tsc --noEmit` from a package |
| Lint | `npm run lint --workspace @fatos/core` or `npx eslint src` from a package |
| Build (all) | `npm run build` |
| Build (one package) | `npm run build --workspace @fatos/persistence` |
| Core benchmark | `npm run benchmark --workspace @fatos/core` |

Cross-package dependencies (`@fatos/*`) resolve through each package's **built `dist/`**,
not its `src`. After changing another package's public API (e.g. `@fatos/persistence`),
rebuild it before type-checking or testing dependents. Tests are excluded from
`tsc --noEmit` (root `tsconfig.json`), so type errors inside test files are only caught
by running vitest.
