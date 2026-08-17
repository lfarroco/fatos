# Fatos - Temporal Fact Database

A full-stack, TypeScript-based temporal fact database system for building time-aware, immutable applications.

## Overview

Fatos stores application state as immutable facts rather than mutable objects. This enables:

- **Time-travel debugging** - Inspect state at any point in time
- **Complete audit trails** - Every change is recorded immutably
- **Deterministic state reconstruction** - Same input always produces same state
- **Reactive queries** - Queries that update automatically
- **Full-stack capabilities** - Works client-side (browser) and server-side (Node.js)

## Packages

- **`@fatos/core`** - Shared database engine (query, indexing, fact storage)
- **`@fatos/client`** - Browser-based client library
- **`@fatos/server`** - Node.js server with HTTP/WebSocket APIs
- **`@fatos/react`** - React hooks and integration
- **`@fatos/devtools`** - Browser DevTools extension
- **`@fatos/persistence`** - Storage adapters (PostgreSQL, MongoDB, etc.)
- **`@fatos/chrome-extension`** - Chrome DevTools integration
- **`@fatos/schema-designer`** - Visual schema designer with import/export adapters
- **`@fatos/examples`** - Example applications
- **`@fatos/app-ops-desk`** - Niche demo #1: audit/operations — fulfillment + inventory with time travel
- **`@fatos/app-replay`** - Niche demo #2: time-travel debugging — a flow builder with scrub, diff, undo, export
- **`@fatos/app-liveboard`** - Niche demo #3: realtime collaboration — a multi-client kanban board

## Quick Start

### Prerequisites

- Node.js 18+
- npm 9+ (with workspaces support)

### Setup

```bash
git clone <repo>
cd fatos
npm install
npm run build
npx vitest run   # one-shot test pass (npm run test starts vitest in watch mode)
```

### Development

```bash
# Watch mode for all packages
npm run dev

# Build all packages
npm run build

# Run tests in watch mode (use `npx vitest run` for a one-shot pass)
npm run test

# Lint and type check
npm run lint
npm run types
```

### Browser E2E tests

Real-browser tests (Playwright) that boot the demo apps and drive their actual
UI — see `playwright.config.ts` and `e2e/`.

```bash
# One-time: install the Playwright browser
npm run test:e2e:install

# Run the e2e suite (starts the demo app's dev server automatically)
npm run test:e2e
```

## Architecture

```
┌─────────────────────────────────┐
│  Browser Application (React)    │
│  ├── @fatos/client              │
│  ├── @fatos/react               │
│  └── @fatos/devtools            │
└─────────────────────────────────┘
           │ WebSocket/HTTP
           ↓
┌─────────────────────────────────┐
│  Fatos Server (Node.js)         │
│  ├── @fatos/server              │
│  ├── @fatos/core                │
│  └── @fatos/persistence         │
└─────────────────────────────────┘
           │
           ↓
┌─────────────────────────────────┐
│  Storage Layer                  │
│  (PostgreSQL, MongoDB, File)    │
└─────────────────────────────────┘
```

## Documentation

- [docs/README.md](./docs/README.md) - Package usage guides
- [docs/client-guide.md](./docs/client-guide.md) - How to use `@fatos/client`
- [docs/react-guide.md](./docs/react-guide.md) - How to use `@fatos/react`
- [docs/running-demo-apps.md](./docs/running-demo-apps.md) - How to run the three demo apps
- [docs/niche-validation.md](./docs/niche-validation.md) - Where Fatos fits (demo-app findings)
- [docs/niche-gap-tasks.md](./docs/niche-gap-tasks.md) - Task list for the gaps the demos surfaced
- [docs/framework-vision.md](./docs/framework-vision.md) - Framework direction: Django-style data framework, temporal admin, Postgres backend
- [PLAN.md](./PLAN.md) - Detailed project plan and design decisions
- [tasks.md](./tasks.md) - Work items for the framework direction and open gaps

## Contributing

Early stage - features and APIs are subject to change.

## License

MIT — see [LICENSE](./LICENSE).

