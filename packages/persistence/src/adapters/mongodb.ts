/**
 * MongoDB adapter — one document per database snapshot (design/04
 * persistence).
 *
 * Driver-injected: this package adds no `mongodb` dependency. Pass any
 * collection-like object exposing `findOne(filter)` and
 * `replaceOne(filter, replacement, options)` — a real `mongodb` Collection
 * qualifies structurally:
 *
 * ```ts
 * import { MongoClient } from 'mongodb';
 * const client = new MongoClient(uri);
 * const adapter = new MongoAdapter(client.db('fatos').collection('snapshots'));
 * ```
 *
 * The snapshot lives in a single document `{ _id: 'fatos-snapshot', payload }`;
 * `save()` replaces it with `{ upsert: true }` (atomic per document). The
 * adapter never closes a client it was handed — callers own their driver
 * lifecycle.
 *
 * Values are persisted through the core wire tags (`$ref` / `$date` /
 * `$bigint`), so Date, bigint, and ref values round-trip losslessly.
 */

import { deserializeSnapshot, serializeSnapshot } from '../serialization';
import type { DatabaseSnapshot, StorageAdapter } from '../types';

/** The minimal collection surface the adapter needs (see file header). */
export interface MongoCollectionLike {
	findOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	replaceOne(
		filter: Record<string, unknown>,
		replacement: Record<string, unknown>,
		options?: { upsert?: boolean }
	): Promise<unknown>;
}

/** The `_id` of the single snapshot document. */
export const MONGO_DOCUMENT_ID = 'fatos-snapshot';

export class MongoAdapter implements StorageAdapter {
	constructor(private readonly collection: MongoCollectionLike) {}

	async load(): Promise<DatabaseSnapshot> {
		const doc = await this.collection.findOne({ _id: MONGO_DOCUMENT_ID });
		if (!doc) {
			return { facts: [], transactions: [] };
		}

		return deserializeSnapshot(doc.payload);
	}

	async save(snapshot: DatabaseSnapshot): Promise<void> {
		const payload = serializeSnapshot(snapshot);
		await this.collection.replaceOne(
			{ _id: MONGO_DOCUMENT_ID },
			{ _id: MONGO_DOCUMENT_ID, payload },
			{ upsert: true }
		);
	}

	async close(): Promise<void> {
		// The injected collection is owned by the caller; nothing to release here.
	}
}

