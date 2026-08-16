/**
 * MongoDB adapter — one document per database snapshot plus an append-only
 * transaction log (design/04 persistence).
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
 * `save()` replaces it with `{ upsert: true }` (atomic per document). When the
 * injected collection also supports `insertOne` / `find` / `deleteMany` (a
 * real Collection does), the adapter additionally exposes `append()`: one log
 * document `{ _id: 'fatos-log-<tx>', tx, payload }` per committed transaction
 * (O(transaction size)). `load()` replays the snapshot plus log documents
 * newer than the snapshot's last tx (a checkpoint-then-crash-before-truncate
 * never double-replays); `save()` is also the compaction checkpoint — it
 * replaces the snapshot and deletes log documents at or below the snapshot's
 * last tx. A collection lacking `insertOne`/`find` gets no `append` method, so
 * callers fall back to `save()` (the optional-contract in types.ts). The
 * adapter never closes a client it was handed — callers own their driver
 * lifecycle.
 *
 * Values are persisted through the core wire tags (`$ref` / `$date` /
 * `$bigint`), so Date, bigint, and ref values round-trip losslessly.
 */

import type { Fact, TransactionRecord } from '@fatos/core';
import { deserializeLogEntry, deserializeSnapshot, serializeLogEntry, serializeSnapshot } from '../serialization';
import type { DatabaseSnapshot, StorageAdapter } from '../types';

/** A cursor-like result of a log query (a real driver returns a `FindCursor`). */
export interface MongoLogCursorLike {
	toArray(): Promise<readonly Record<string, unknown>[]>;
}

/**
 * The minimal collection surface the adapter needs (see file header). The
 * `insertOne` / `find` / `deleteMany` members are the optional append surface:
 * `append` is only exposed when the collection can insert and query log
 * documents.
 */
export interface MongoCollectionLike {
	findOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	replaceOne(
		filter: Record<string, unknown>,
		replacement: Record<string, unknown>,
		options?: { upsert?: boolean }
	): Promise<unknown>;
	/** Optional append surface: insert one log document. */
	insertOne?(document: Record<string, unknown>): Promise<unknown>;
	/** Optional append surface: query log documents. */
	find?(filter: Record<string, unknown>, options?: { sort?: Record<string, 1 | -1> }): MongoLogCursorLike;
	/** Optional append surface: delete log documents matching a filter. */
	deleteMany?(filter: Record<string, unknown>): Promise<unknown>;
}

/** The `_id` of the single snapshot document. */
export const MONGO_DOCUMENT_ID = 'fatos-snapshot';
/** The `_id` prefix of append-log documents (`fatos-log-<tx>`). */
export const MONGO_LOG_ID_PREFIX = 'fatos-log-';

export class MongoAdapter implements StorageAdapter {
	/**
	 * Optional append fast path, present only when the injected collection can
	 * insert and query log documents. The server checks
	 * `typeof storage.append === 'function'` and otherwise falls back to
	 * `save()` (see types.ts).
	 */
	append?: (transaction: TransactionRecord, facts: readonly Fact[]) => Promise<void>;

	constructor(private readonly collection: MongoCollectionLike) {
		if (typeof collection.insertOne === 'function' && typeof collection.find === 'function') {
			this.append = (transaction, facts) => this.appendTransaction(transaction, facts);
		}
	}

	private async appendTransaction(transaction: TransactionRecord, facts: readonly Fact[]): Promise<void> {
		if (typeof this.collection.insertOne !== 'function') {
			throw new Error('MongoAdapter: injected collection does not support append');
		}

		const payload = serializeLogEntry(transaction, facts);
		await this.collection.insertOne({
			_id: `${MONGO_LOG_ID_PREFIX}${transaction[0]}`,
			tx: transaction[0],
			payload
		});
	}

	async load(): Promise<DatabaseSnapshot> {
		const doc = await this.collection.findOne({ _id: MONGO_DOCUMENT_ID });
		const snapshot = doc ? deserializeSnapshot(doc.payload) : { facts: [], transactions: [] };

		// Replay log documents newer than the snapshot; anything at or below
		// the snapshot's last tx is already inside it (checkpoint-then-crash-
		// before-truncate must never double-replay).
		const maxTx = snapshot.transactions.length > 0 ? snapshot.transactions[snapshot.transactions.length - 1][0] : 0;

		const facts = snapshot.facts.slice();
		const transactions = snapshot.transactions.slice();
		if (typeof this.collection.find === 'function') {
			const cursor = this.collection.find({ tx: { $gt: maxTx } }, { sort: { tx: 1 } });
			for (const logDoc of await cursor.toArray()) {
				const entry = deserializeLogEntry(logDoc.payload);
				if (entry.transaction[0] > maxTx) {
					transactions.push(entry.transaction);
					for (const fact of entry.facts) {
						facts.push(fact);
					}
				}
			}
		}

		return { facts, transactions };
	}

	/**
	 * Compaction checkpoint: atomically replaces the snapshot document, then
	 * deletes log documents at or below the snapshot's last tx so the log
	 * never outlives the data it duplicates.
	 */
	async save(snapshot: DatabaseSnapshot): Promise<void> {
		const payload = serializeSnapshot(snapshot);
		await this.collection.replaceOne(
			{ _id: MONGO_DOCUMENT_ID },
			{ _id: MONGO_DOCUMENT_ID, payload },
			{ upsert: true }
		);

		if (typeof this.collection.deleteMany === 'function') {
			const maxTx = snapshot.transactions.length > 0 ? snapshot.transactions[snapshot.transactions.length - 1][0] : 0;
			await this.collection.deleteMany({ tx: { $lte: maxTx } });
		}
	}

	async close(): Promise<void> {
		// The injected collection is owned by the caller; nothing to release here.
	}
}

