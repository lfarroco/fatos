/**
 * MongoAdapter tests against a fake in-memory collection (no real `mongodb`
 * driver needed).
 */

import { describe, it, expect } from 'vitest';
import { MongoAdapter, MONGO_DOCUMENT_ID, type MongoCollectionLike } from '../adapters/mongodb';
import { comparableFacts, makeRichSnapshot } from './fixtures';

/** A fake `mongodb` Collection holding a single document in memory. */
class FakeMongoCollection implements MongoCollectionLike {
	private doc: Record<string, unknown> | null = null;

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
});
