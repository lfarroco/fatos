/**
 * MongoAdapter tests against a fake in-memory collection (no real `mongodb`
 * driver needed). The fake holds the snapshot document plus the append-log
 * documents.
 */

import { describe, it, expect } from 'vitest';
import { MongoAdapter, MONGO_DOCUMENT_ID, type MongoCollectionLike, type MongoLogCursorLike } from '../adapters/mongodb';
import { comparableFacts, makeRichSnapshot } from './fixtures';

/** A fake `mongodb` Collection: snapshot document plus an id-prefixed log map. */
class FakeMongoCollection implements MongoCollectionLike {
	private doc: Record<string, unknown> | null = null;
	private readonly logDocs = new Map<string, { tx: number; payload: unknown }>();

	async findOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null> {
		expect(filter._id).toBe(MONGO_DOCUMENT_ID);
		return this.doc;
	}

	async replaceOne(
		filter: Record<string, unknown>,
		replacement: Record<string, unknown>,
		options?: { upsert?: boolean }
	): Promise<unknown> {
		expect(filter._id).toBe(MONGO_DOCUMENT_ID);
		expect(options?.upsert).toBe(true);
		this.doc = replacement;
		return { acknowledged: true };
	}

	async insertOne(document: Record<string, unknown>): Promise<unknown> {
		this.logDocs.set(String(document._id), document as { tx: number; payload: unknown });
		return { acknowledged: true };
	}

	async deleteMany(filter: Record<string, unknown>): Promise<unknown> {
		const maxTx = (filter.tx as { $lte: number }).$lte;
		for (const [id, logDoc] of [...this.logDocs]) {
			if (logDoc.tx <= maxTx) {
				this.logDocs.delete(id);
			}
		}
		return { acknowledged: true, deletedCount: 0 };
	}

	find(filter: Record<string, unknown>): MongoLogCursorLike {
		const minTx = (filter.tx as { $gt: number }).$gt;
		const docs = [...this.logDocs.values()]
			.filter((logDoc) => logDoc.tx > minTx)
			.sort((a, b) => a.tx - b.tx);
		return { toArray: async () => docs };
	}

	get logCount(): number {
		return this.logDocs.size;
	}
}


describe('MongoAdapter', () => {
	it('returns an empty snapshot when no document exists', async () => {
		const adapter = new MongoAdapter(new FakeMongoCollection());
		await expect(adapter.load()).resolves.toEqual({ facts: [], transactions: [] });
	});

	it('round-trips a rich snapshot through the fake collection', async () => {
		const collection = new FakeMongoCollection();
		const adapter = new MongoAdapter(collection);
		const snapshot = makeRichSnapshot();

		await adapter.save(snapshot);
		const loaded = await adapter.load();

		expect(comparableFacts(loaded.facts)).toEqual(comparableFacts(snapshot.facts));
		expect(loaded.transactions).toEqual(snapshot.transactions);
	});

	it('a second adapter on the same collection sees the saved snapshot', async () => {
		const collection = new FakeMongoCollection();
		await new MongoAdapter(collection).save(makeRichSnapshot());

		const reader = new MongoAdapter(collection);
		const loaded = await reader.load();
		expect(loaded.facts.length).toBeGreaterThan(0);
		expect(loaded.transactions).toHaveLength(3);
	});

	it('propagates driver errors', async () => {
		const failing: MongoCollectionLike = {
			async findOne() {
				throw new Error('not authorized');
			},
			async replaceOne() {
				throw new Error('not authorized');
			}
		};

		const adapter = new MongoAdapter(failing);
		await expect(adapter.load()).rejects.toThrow(/not authorized/);
	});

	it('does not expose append when the collection lacks insert support', async () => {
		const collection: MongoCollectionLike = {
			async findOne() {
				return null;
			},
			async replaceOne() {
				return {};
			}
		};

		const adapter = new MongoAdapter(collection);
		expect(adapter.append).toBeUndefined();
	});

	it('replays append-only writes through load()', async () => {
		const collection = new FakeMongoCollection();
		const adapter = new MongoAdapter(collection);
		expect(adapter.append).toBeTypeOf('function');

		await adapter.append?.([1, 1, null], [[1, 'type', 'user', 1, 'add']]);
		await adapter.append?.([2, 2, null], [[1, 'age', 30, 2, 'add']]);

		const loaded = await adapter.load();
		expect(loaded.transactions).toEqual([
			[1, 1, null],
			[2, 2, null]
		]);
		expect(loaded.facts).toEqual([
			[1, 'type', 'user', 1, 'add'],
			[1, 'age', 30, 2, 'add']
		]);
	});

	it('merges the snapshot with newer log entries, in order, without duplication', async () => {
		const collection = new FakeMongoCollection();
		const adapter = new MongoAdapter(collection);
		const snapshot = makeRichSnapshot();

		await adapter.save(snapshot);
		await adapter.append?.([4, 4, null], [[3, 'user/name', 'Carol', 4, 'add']]);

		const loaded = await adapter.load();
		expect(comparableFacts(loaded.facts)).toEqual([
			...comparableFacts(snapshot.facts),
			[3, 'user/name', 'Carol', 4, 'add']
		]);
		expect(loaded.transactions).toEqual([...snapshot.transactions, [4, 4, null]]);
	});

	it('checkpoint truncates the append log after save()', async () => {
		const collection = new FakeMongoCollection();
		const adapter = new MongoAdapter(collection);

		await adapter.append?.([1, 1, null], [[1, 'type', 'user', 1, 'add']]);
		await adapter.append?.([2, 2, null], [[1, 'age', 30, 2, 'add']]);
		expect(collection.logCount).toBe(2);

		await adapter.save({
			facts: [
				[1, 'type', 'user', 1, 'add'],
				[1, 'age', 30, 2, 'add']
			],
			transactions: [
				[1, 1, null],
				[2, 2, null]
			]
		});

		// The checkpoint deletes log documents at or below the snapshot's last tx.
		expect(collection.logCount).toBe(0);

		const loaded = await adapter.load();
		expect(loaded.transactions).toEqual([
			[1, 1, null],
			[2, 2, null]
		]);
		expect(loaded.facts).toEqual([
			[1, 'type', 'user', 1, 'add'],
			[1, 'age', 30, 2, 'add']
		]);
	});

	it('skips log entries whose tx is already inside the snapshot', async () => {
		const collection = new FakeMongoCollection();
		const adapter = new MongoAdapter(collection);
		const snapshot = makeRichSnapshot();

		await adapter.save(snapshot);
		// Re-append the last snapshot transaction: it was already checkpointed
		// (crash between checkpoint and log truncate must not double-replay).
		const lastTx = snapshot.transactions[snapshot.transactions.length - 1];
		await adapter.append?.(lastTx, snapshot.facts.filter((fact) => fact[3] === lastTx[0]));

		const loaded = await adapter.load();
		expect(comparableFacts(loaded.facts)).toEqual(comparableFacts(snapshot.facts));
		expect(loaded.transactions).toEqual(snapshot.transactions);
	});

	it('save-then-append-then-load round-trip preserves transaction order', async () => {
		const collection = new FakeMongoCollection();
		const adapter = new MongoAdapter(collection);

		await adapter.save({
			facts: [
				[1, 'type', 'user', 1, 'add'],
				[1, 'age', 30, 2, 'add']
			],
			transactions: [
				[1, 1, null],
				[2, 2, null]
			]
		});
		await adapter.append?.([3, 3, null], [[1, 'name', 'Alice', 3, 'add']]);

		const loaded = await adapter.load();
		expect(loaded.transactions).toEqual([
			[1, 1, null],
			[2, 2, null],
			[3, 3, null]
		]);
		expect(loaded.facts).toEqual([
			[1, 'type', 'user', 1, 'add'],
			[1, 'age', 30, 2, 'add'],
			[1, 'name', 'Alice', 3, 'add']
		]);
	});
});
