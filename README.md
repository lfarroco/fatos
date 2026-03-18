# Fatos - Temporal Fact Database

A full-stack, TypeScript-based temporal fact database system for building time-aware, immutable applications.

**Status**: Early development (Phase 1)

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
npm run test
```

### Development

```bash
# Watch mode for all packages
npm run dev

# Build all packages
npm run build

# Run tests
npm run test

# Lint and type check
npm run lint
npm run types
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

## Development Phases

- **Phase 1** ✓ Core database engine, fact storage, transactions, indexing
- **Phase 2** React integration, client-side implementation
- **Phase 3** Server implementation, multi-client sync
- **Phase 4** DevTools browser extension
- **Phase 5** Persistence layer and adapters
- **Phase 6** Advanced features (time-travel UI, graph visualization)

## Documentation

See [PLAN.md](./PLAN.md) for detailed project plan and design decisions.

## Contributing

Early stage - features and APIs are subject to change.

## License

(To be determined)
