/**
 * @fatos/persistence — shared adapter contracts (design/04 persistence).
 *
 * A `StorageAdapter` is a durable home for a `DatabaseSnapshot` — the full
 * append-only fact log plus the transaction ledger. Adapters implement
 * `load()` / `save()` / `close()`; the engine's `FactDatabase.restore()`
 * consumes what `load()` returns so a restarted process behaves identically.
 */

import type { DatabaseSnapshot } from '@fatos/core';

export type { DatabaseSnapshot } from '@fatos/core';

/**
 * Contract every persistence backend implements. `load()` returns an empty
 * snapshot (`{ facts: [], transactions: [] }`) when the backend holds no data
 * yet. `save()` persists the complete snapshot atomically enough that a crash
 * mid-write never corrupts a previously saved snapshot (see each adapter's
 * header for backend-specific guarantees). `close()` releases adapter-held
 * resources; adapters never close driver resources they were handed (callers
 * own their pool/client/collection).
 */
export interface StorageAdapter {
	load(): Promise<DatabaseSnapshot>;
	save(snapshot: DatabaseSnapshot): Promise<void>;
	close(): Promise<void>;
}
