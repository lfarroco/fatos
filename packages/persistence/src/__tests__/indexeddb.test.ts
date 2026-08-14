/**
 * IndexedDBAdapter tests against a tiny fake `indexedDB` stubbed onto
 * globalThis (jsdom-less; environment is Node). The fake implements just the
 * structural surface the adapter uses: open → db → transaction → object store
 * → get/put requests, with asynchronous resolution.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { IndexedDBAdapter } from '../adapters/indexeddb';
import { comparableFacts, makeRichSnapshot } from './fixtures';

const originalIndexedDB = (globalThis as { indexedDB?: unknown }).indexedDB;

type FakeEvent<T> = { target: { result: T } };
type FakeErrorEvent = { target: { error: Error } };

class FakeRequest<T> {
	onsuccess: ((event: FakeEvent<T>) => void) | null = null;
	onerror: ((event: FakeErrorEvent) => void) | null = null;

	resolve(result: T): void {
		this.onsuccess?.({ target: { result } });
	}

	fail(error: Error): void {
		this.onerror?.({ target: { error } });
	}
}

class FakeOpenRequest extends FakeRequest<FakeDatabase> {
	onupgradeneeded: ((event: FakeEvent<FakeDatabase>) => void) | null = null;
}

class FakeObjectStore {
	private readonly records = new Map<string, unknown>();

	get(key: string): FakeRequest<unknown> {
		const request = new FakeRequest<unknown>();
		queueMicrotask(() => request.resolve(this.records.get(key)));
		return request;
	}

	put(value: unknown, key: string): FakeRequest<unknown> {
		const request = new FakeRequest<unknown>();
		this.records.set(key, value);
		queueMicrotask(() => request.resolve(value));
		return request;
	}
}

class FakeDatabase {
	readonly store = new FakeObjectStore();
	closed = false;
	objectStoreNames = { contains: () => true };

	createObjectStore(): FakeObjectStore {
		return this.store;
	}

	transaction(_name: string, _mode: 'readonly' | 'readwrite'): { objectStore: () => FakeObjectStore } {
		return { objectStore: () => this.store };
	}

	close(): void {
		this.closed = true;
	}
}

/** A fake `indexedDB` factory keeping one database per name across opens. */
function createFakeIndexedDB(): { open: (name: string) => FakeOpenRequest; databases: () => Map<string, FakeDatabase> } {
	const databases = new Map<string, FakeDatabase>();

	return {
		open(name: string): FakeOpenRequest {
			const request = new FakeOpenRequest();
			queueMicrotask(() => {
				let database = databases.get(name);
				if (!database) {
					database = new FakeDatabase();
					databases.set(name, database);
					request.onupgradeneeded?.({ target: { result: database } });
				}
				request.resolve(database);
			});
			return request;
		},
		databases: () => databases
	};
}

afterEach(() => {
	(globalThis as { indexedDB?: unknown }).indexedDB = originalIndexedDB;
});

describe('IndexedDBAdapter', () => {
	it('throws a clear error when indexedDB is unavailable', async () => {
		(globalThis as { indexedDB?: unknown }).indexedDB = undefined;

		const adapter = new IndexedDBAdapter();
		await expect(adapter.load()).rejects.toThrow(/indexedDB is not available/);
	});

	it('returns an empty snapshot when no record exists', async () => {
		(globalThis as { indexedDB?: unknown }).indexedDB = createFakeIndexedDB();

		const adapter = new IndexedDBAdapter();
		await expect(adapter.load()).resolves.toEqual({ facts: [], transactions: [] });
	});

	it('round-trips a rich snapshot through the fake', async () => {
		(globalThis as { indexedDB?: unknown }).indexedDB = createFakeIndexedDB();

		const snapshot = makeRichSnapshot();
		const adapter = new IndexedDBAdapter();

		await adapter.save(snapshot);
		const loaded = await adapter.load();

		expect(comparableFacts(loaded.facts)).toEqual(comparableFacts(snapshot.facts));
		expect(loaded.transactions).toEqual(snapshot.transactions);
	});

	it('a second adapter on the same database sees the saved snapshot', async () => {
		(globalThis as { indexedDB?: unknown }).indexedDB = createFakeIndexedDB();

		await new IndexedDBAdapter({ databaseName: 'shared' }).save(makeRichSnapshot());

		const reader = new IndexedDBAdapter({ databaseName: 'shared' });
		const loaded = await reader.load();
		expect(loaded.facts.length).toBeGreaterThan(0);
		expect(loaded.transactions).toHaveLength(3);
	});

	it('close() releases the connection and the adapter stays usable', async () => {
		const fake = createFakeIndexedDB();
		(globalThis as { indexedDB?: unknown }).indexedDB = fake;

		const adapter = new IndexedDBAdapter({ databaseName: 'closing' });
		await adapter.save(makeRichSnapshot());
		await adapter.close();

		const database = fake.databases().get('closing');
		expect(database?.closed).toBe(true);

		const loaded = await adapter.load();
		expect(loaded.facts.length).toBeGreaterThan(0);
	});

	it('throws a clear error on a malformed stored record', async () => {
		const fake = createFakeIndexedDB();
		(globalThis as { indexedDB?: unknown }).indexedDB = fake;

		// Open once through the adapter path so the database exists.
		const adapter = new IndexedDBAdapter({ databaseName: 'corrupt' });
		await adapter.load();
		fake.databases().get('corrupt')?.store.put({ key: 'fatos-snapshot' }, 'fatos-snapshot');

		await expect(adapter.load()).rejects.toThrow(/stored snapshot record is malformed/);
	});
});
