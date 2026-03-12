# Project Plan: Fatos - Fact Database

## Overview

Fatos is a lightweight temporal fact database system for building scalable, time-aware applications. It can run **client-side in browsers** and **server-side** as a backend service, both written in **TypeScript**.

The database stores application state as immutable facts rather than mutable objects. This enables powerful capabilities such as:

- Time-travel debugging
- Deterministic state reconstruction
- Flexible schemas
- Reactive queries
- Rich developer tooling
- Temporal queries and auditing

The system is designed for:
- Frontend applications (especially React apps) acting as a client-side database and state management layer
- Backend services for event sourcing, audit logs, and temporal data management
- Full-stack applications with client-server synchronization

A companion browser DevTools extension will allow developers to visualize and inspect the fact store in real time.

The overall goal is to create a developer experience similar to modern frontend state tools and backend event stores, but built around an immutable temporal fact model.

## Core Data Model

The database stores information as immutable facts.

### Fact Structure

Each fact has the structure:

```
[eid, attribute, value, tx, op]
```

Where:

| Field       | Description                             |
|-------------|-----------------------------------------|
| `eid`       | Entity identifier                       |
| `attribute` | Attribute name or key                   |
| `value`     | Stored value                            |
| `tx`        | Transaction identifier                  |
| `op`        | Operation type (`"add"` or `"retract"`) |

Facts are append-only. Updates are represented by adding new facts rather than mutating existing ones.

### Example

```javascript
[123, "name", "Alice", 1, "add"]
[123, "age", 22, 1, "add"]
[123, "age", 22, 2, "retract"]
[123, "age", 23, 2, "add"]
```

## Transactions

Facts are written inside transactions. Transaction metadata is stored separately:

```
transactions: [tx_id, timestamp, metadata]
```

### Example

```javascript
[1, 1700000000, {source: "ui"}]
[2, 1700000100, {source: "api"}]
```

### Benefits

- Deterministic ordering
- Consistent history
- Time-travel queries
- Transaction grouping
- Audit trail capabilities

## Indexes

Efficient querying requires multiple indexes. Recommended indexes:

- **EAVT** → entity → attribute → value → tx
- **AEVT** → attribute → entity → value → tx
- **AVET** → attribute → value → entity → tx

These indexes allow efficient filtering for most query patterns.

## Core Database API

### Creating the database

```typescript
const db = createDatabase()
```

### Writing data

```typescript
db.add(eid, attribute, value)

db.retract(eid, attribute, value)

db.transact([
  ["add", eid, attribute, value],
  ["retract", eid, attribute, value]
])
```

### Querying

**Simple query:**

```typescript
db.find({ age: 22 })
```

**Datalog-style query:**

```typescript
db.query({
  find: ["?e"],
  where: [
    ["?e", "age", 22]
  ]
})
```

### Entity API

Provide helper methods to work with entities:

```typescript
db.entity(123)
```

Example result:

```javascript
{
  id: 123,
  name: "Alice",
  age: 22
}
```

## Reactive Queries

Reactive queries automatically update when relevant facts change.

### Example

```typescript
const users = db.observe({
  type: "user"
})
```

In React:

```typescript
const users = useQuery({
  where: [
    ["?e", "type", "user"]
  ]
})
```

The UI automatically re-renders when the query result changes.

## React Integration

Provide a small React package with hooks for browser-based applications.

### Core hooks

- `useQuery(query)` - Subscribe to reactive query results
- `useEntity(eid)` - Get entity data and updates
- `useTransaction()` - Access transaction information

### Example

```typescript
const user = useEntity(userId)

return <div>{user.name}</div>
```

## DevTools Browser Extension

A major feature of the project is a developer inspection tool similar to React DevTools.

The extension should allow developers to inspect the fact database inside running applications.

### Features

#### Fact Table
Display all facts in tabular format:
- entity | attribute | value | tx | operation

#### Entity View
Show all attributes for a selected entity.

#### Query Inspector
Allow developers to run queries against the database.

#### Timeline View
Visualize transactions over time.

#### Diff View
Show what changed between transactions.

#### Graph View
Visualize relationships between entities.

## Time Travel

Because facts are immutable and transactions are ordered, the system supports time travel.

Developers can inspect database state at a specific transaction:

```typescript
db.atTransaction(5)
```

### Use cases

- Debugging state at specific points
- Replaying user sessions
- Historical queries
- Auditing changes

## Persistence

### Initial version

In-memory storage for rapid development and prototyping.

### Later versions

Optional persistence backends:

- **IndexedDB** - Browser-based persistence
- **localStorage** - Simple key-value storage
- **File export/import** - Snapshot management
- **Optional sync backends** - Server synchronization

## Server-Side Implementation

Fatos also runs as a TypeScript server, enabling:

### Core Features

- **Persistent storage** - Facts persisted to disk or databases (PostgreSQL, MongoDB, etc.)
- **Multi-client support** - Multiple clients connect to shared fact database
- **Real-time synchronization** - Changes propagated to connected clients
- **Transaction log** - Complete audit trail of all changes
- **Query API** - HTTP/WebSocket endpoints for fact queries
- **Event streaming** - Real-time fact streams for subscribers

### Architecture

```
┌─────────────────────────────────────┐
│   Client (Browser)                  │
│   ├── Core Database                 │
│   └── React Integration             │
└─────────────────────────────────────┘
           │ WebSocket/HTTP
           ↓
┌─────────────────────────────────────┐
│   Fatos Server (Node.js/TypeScript)  │
│   ├── Fact Store                    │
│   ├── Index Layer                   │
│   ├── Query Engine                  │
│   └── Persistence Layer             │
└─────────────────────────────────────┘
           │
           ↓
┌─────────────────────────────────────┐
│   Persistent Storage                │
│   (PostgreSQL, MongoDB, File, etc.) │
└─────────────────────────────────────┘
```

### Server APIs

#### REST Endpoints

```typescript
POST /facts - Add facts
GET /facts - Query facts
GET /facts/:eid - Get entity
GET /transactions - Get transaction log
POST /transact - Execute transaction
```

#### WebSocket Events

```typescript
// Client subscribes to fact changes
subscribe({ where: [["?e", "type", "user"]] })

// Server pushes updates
fact:added
fact:retracted
transaction:committed
```

## Technology Stack

### Core

- **Language**: TypeScript (all platforms)
- **Node.js Runtime**: v18+ (server)
- **Browser APIs**: Standard DOM (client)

### Client

- **React Integration**: React 18+
- **State Management**: Immutable fact store
- **DevTools**: React DevTools integration

### Server

- **Runtime**: Node.js with TypeScript
- **HTTP Server**: Express or Fastify
- **WebSocket**: ws or Socket.io
- **Database**: PostgreSQL (primary), support for MongoDB, File storage
- **Job Queue**: Optional (Bull, RabbitMQ for async operations)

### Development

- **Package Manager**: npm/yarn/pnpm
- **Build Tool**: esbuild/tsc
- **Testing**: Jest, Vitest
- **Type Safety**: Full TypeScript coverage

## Performance Goals

### Target usage

- Tens of thousands of facts (client-side)
- Millions of facts (server-side with proper indexing)
- Interactive query performance
- Minimal UI latency

### Strategies

- Persistent indexes
- Structural sharing
- Incremental query recomputation
- Efficient transaction batching
- Connection pooling (server)
- Query result caching

## Project Structure

Suggested monorepo structure:

```
packages/
├── core/              # Shared core database engine (TypeScript)
├── server/            # Server implementation (Node.js)
├── client/            # Client implementation (browser)
├── react/             # React bindings and hooks
├── devtools/          # Inspection UI components
├── chrome-extension/  # Browser extension wrapper
├── persistence/       # Storage adapters (PostgreSQL, MongoDB, etc.)
└── examples/          # Example applications
```

### Package descriptions

| Package            | Purpose                                                        |
|--------------------|----------------------------------------------------------------|
| `core`             | Immutable database engine, query engine, indexing              |
| `server`           | HTTP/WebSocket server, persistence layer, multi-client support |
| `client`           | Browser client library, in-memory store                        |
| `react`            | React hooks and components                                     |
| `devtools`         | Inspection UI components and DevTools extension                |
| `chrome-extension` | Browser extension wrapper                                      |
| `persistence`      | Database adapters (PostgreSQL, MongoDB, Firebase, etc.)        |
| `examples`         | Sample applications demonstrating usage                        |

## Development Priorities

### Phase 1: Core database (shared across client/server)

- [x] Fact storage and management
- [x] Transactions and transaction log
- [x] Index structures (EAVT, AEVT, AVET)
- [x] Query engine (Datalog-style)
- [x] Schema as facts (`db/ident`, `db/valueType`, `db/cardinality`) with collection support (`cardinality: many`)

### Phase 2: Client implementation

- [x] Browser API and in-memory store
- [x] React integration and hooks
- [x] Reactive queries

### Phase 3: Server implementation

- [x] Node.js server with HTTP API
- [ ] WebSocket transport
- [x] Multi-client coordination
- [x] Real-time synchronization

### Phase 4: DevTools

- Browser extension
- Fact inspector UI
- Query console
- Timeline visualization

### Phase 5: Persistence

- PostgreSQL adapter
- IndexedDB adapter (client)
- Query optimization for large datasets

### Phase 6: Advanced features

- Time travel UI
- Graph visualization
- Export/import functionality
- Client-server sync strategies

## Non-Goals (initial version)

These features are not priorities for the initial release but may be explored in future versions:

- Distributed replication across multiple servers
- CRDT conflict resolution for offline-first scenarios
- Complex authorization/permission systems
- Full-text search capabilities
- Sharding and horizontal scaling (Phase 2+)

## Guiding Principles

- **Immutable facts** - All data is immutable
- **Append-only history** - Complete audit trail
- **Deterministic queries** - Same query always produces same results
- **Developer-friendly debugging** - Rich tooling and visibility
- **Small and composable core** - Core library is lightweight and focused
- **Great DevTools experience** - Inspect and understand your data
- **TypeScript everywhere** - Type safety across client and server
- **Temporal by design** - Time is first-class in the data model

## Inspiration

The project draws inspiration from:

- Entity–attribute–value (EAV) data models
- Temporal databases
- Event sourcing architectures
- Reactive frontend state systems
- Datomic/DataScript temporal logic
- Apache Kafka event streaming
- Redux and modern state management

The goal is to bring these ideas into a unified, full-stack developer experience with TypeScript as the common language.