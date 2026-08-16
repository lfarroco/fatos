/**
 * @fatos/persistence — shared adapter contracts (design/04 persistence).
 *
 * A `StorageAdapter` is a durable home for a `DatabaseSnapshot` — the full
 * append-only fact log plus the transaction ledger. Adapters implement
 * `load()` / `save()` / `close()`; the engine's `FactDatabase.restore()`
 * consumes what `load()` returns so a restarted process behaves identically.
 */

import type { DatabaseSnapshot, Fact, TransactionRecord } from '@fatos/core';

export type { DatabaseSnapshot } from '@fatos/core';

/**
 * Contract every persistence backend implements. `load()` returns an empty
 * snapshot (`{ facts: [], transactions: [] }`) when the backend holds no data
 * yet. `save()` persists the complete snapshot atomically enough that a crash
 * mid-write never corrupts a previously saved snapshot (see each adapter's
 * header for backend-specific guarantees). `close()` releases adapter-held
 * resources; adapters never close driver resources they were handed (callers
 * own their pool/client/collection).
 *
 * Adapters may additionally implement {@link StorageAdapter.append} — an
 * append-only fast path that records one committed transaction (its transaction
 * record plus its facts) without re-serializing the whole database. Adapters
 * without `append` keep working through `save()` alone: the `save()` full
 * snapshot doubles as the compaction checkpoint that keeps an append log
 * bounded (the server compacts on stop). `append` never changes the meaning of
 * `load()`: a load must return every transaction/fact the adapter has
 * received, whether stored as a snapshot, a log, or a combination of both.
 */
export interface StorageAdapter {
	load(): Promise<DatabaseSnapshot>;
	save(snapshot: DatabaseSnapshot): Promise<void>;
	/**
	 * Optional append-only write: persists one committed transaction (its
	 * ledger record plus its facts) in O(transaction size), without touching
	 * the rest of the database. Transactions arrive in strictly ascending tx
	 * order and must be recoverable through `load()` afterwards.
	 */
	append?(transaction: TransactionRecord, facts: readonly Fact[]): Promise<void>;
	close(): Promise<void>;
}
