/**
 * @fatos/persistence — storage adapters for the Fatos fact database
 * (design/04 persistence).
 *
 * A {@link StorageAdapter} persists a {@link DatabaseSnapshot} — the full
 * append-only fact log plus the transaction ledger — and `FactDatabase.restore()`
 * consumes what `load()` returns. Includes:
 * - `FileAdapter` (Node): atomic JSON file writes.
 * - `PostgresAdapter` / `MongoAdapter`: driver-injected backends (bring your
 *   own `pg` / `mongodb`).
 * - `IndexedDBAdapter`: browser client persistence via the global `indexedDB`.
 * - `MemoryAdapter`: in-memory store for tests.
 */

export const version = '0.0.1';

export type { DatabaseSnapshot, StorageAdapter } from './types';

export { FileAdapter } from './adapters/file';
export { IndexedDBAdapter, type IndexedDBAdapterOptions } from './adapters/indexeddb';
export { MemoryAdapter } from './adapters/memory';
export { MongoAdapter, MONGO_DOCUMENT_ID, type MongoCollectionLike } from './adapters/mongodb';
export { PostgresAdapter, type PostgresAdapterOptions, type SQLExecutor } from './adapters/postgres';

