# AGENTS

## Project

Fatos is a TypeScript monorepo for a temporal fact database that stores immutable facts and transaction history.

Primary goals:
- Temporal, append-only data model
- Deterministic queries and indexing
- Full-stack usage (browser + Node.js server)
- Strong developer tooling (DevTools and examples)

## Monorepo Packages

- `packages/core`: database engine, facts, transactions, indexes, query execution
- `packages/client`: browser-facing client API
- `packages/server`: Node.js server, HTTP/WebSocket API, synchronization
- `packages/react`: React bindings and hooks
- `packages/devtools`: tooling and inspection helpers
- `packages/chrome-extension`: browser extension integration
- `packages/persistence`: storage adapters (file, postgres, mongodb)
- `packages/examples`: usage samples and integration examples

## Source Of Truth For Work

Use [PLAN.md](PLAN.md) as the authoritative source for:
- Roadmap and phase ordering
- Current and upcoming tasks
- Priorities and implementation scope

When deciding what to build next, always align with the Development Priorities and phase checklist in [PLAN.md](PLAN.md).

## Working Guidance For Agents

- Keep changes focused and package-scoped when possible.
- Preserve TypeScript strictness and existing package boundaries.
- Add or update tests with behavior changes.
- Prefer incremental, phase-aligned work over broad refactors.
- If roadmap guidance is ambiguous, follow [PLAN.md](PLAN.md) first, then README context.