/**
 * IndexedDBAdapter tests against a tiny fake `indexedDB` stubbed onto
 * globalThis (jsdom-less; environment is Node). The fake implements just the
 * structural surface the adapter uses: open → db → transaction → object store
 * → get/getAll/put/delete requests, with asynchronous resolution, plus the
 * snapshot and append-log object stores.
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
	private readonly records = new Map<number | string, unknown>();

	get(key: number | string): FakeRequest<unknown> {
		const request = new FakeRequest<unknown>();
		queueMicrotask(() => request.resolve(this.records.get(key)));
		return request;
	}

	getAll(): FakeRequest<unknown[]> {
		const request = new FakeRequest<unknown[]>();
		queueMicrotask(() => request.resolve([...this.records.values()]));
		return request;
	}

	put(value: unknown, key: number | string): FakeRequest<unknown> {
		const request = new FakeRequest<unknown>();
		this.records.set(key, value);
		queueMicrotask(() => request.resolve(value));
		return request;
	}

	delete(key: number | string): FakeRequest<unknown> {
		const request = new FakeRequest<unknown>();
		this.records.delete(key);
		queueMicrotask(() => request.resolve(undefined));
		return request;
	}

	entries(): ReadonlyMap<number | string, unknown> {
		return this.records;
	}
}

class FakeDatabase {
	readonly stores = new Map<string, FakeObjectStore>();
	closed = false;

	constructor() {
		// The adapter opens both stores (version 2); the fake pre-registers
		// them so the upgrade handler's contains() checks are no-ops.
		this.stores.set('snapshot', new FakeObjectStore());
		this.stores.set('log', new FakeObjectStore());
	}

	objectStoreNames = {
		contains: (name: string) => this.stores.has(name)
	};

	createObjectStore(name: string): FakeObjectStore {
		let store = this.stores.get(name);
		if (!store) {
			store = new FakeObjectStore();
			this.stores.set(name, store);
		}
		return store;
	}

	transaction(
		names: string | readonly string[],
		_mode: 'readonly' | 'readwrite'
	): { objectStore: (name: string) => FakeObjectStore } {
		const list = typeof names === 'string' ? [names] : [...names];
		return {
			objectStore: (name: string) => {
				const store = this.stores.get(name);
				if (!store) {
					throw new Error(`fake: no object store "${name}"`);
				}
				return store;
			}
		};
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
		fake.databases().get('corrupt')?.stores.get('snapshot')?.put({ key: 'fatos-snapshot' }, 'fatos-snapshot');

		await expect(adapter.load()).rejects.toThrow(/stored snapshot record is malformed/);
	});

	it('replays append-only writes through load()', async () => {
		(globalThis as { indexedDB?: unknown }).indexedDB = createFakeIndexedDB();
		const adapter = new IndexedDBAdapter();

		await adapter.append([1, 1, null], [[1, 'type', 'user', 1, 'add']]);
		await adapter.append([2, 2, null], [[1, 'age', 30, 2, 'add']]);

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
		(globalThis as { indexedDB?: unknown }).indexedDB = createFakeIndexedDB();
		const adapter = new IndexedDBAdapter();
		const snapshot = makeRichSnapshot();

		await adapter.save(snapshot);
		await adapter.append([4, 4, null], [[3, 'user/name', 'Carol', 4, 'add']]);

		const loaded = await adapter.load();
		expect(comparableFacts(loaded.facts)).toEqual([
			...comparableFacts(snapshot.facts),
			[3, 'user/name', 'Carol', 4, 'add']
		]);
		expect(loaded.transactions).toEqual([...snapshot.transactions, [4, 4, null]]);
	});

	it('checkpoint truncates the append log after save()', async () => {
		const fake = createFakeIndexedDB();
		(globalThis as { indexedDB?: unknown }).indexedDB = fake;
		const adapter = new IndexedDBAdapter();

		await adapter.append([1, 1, null], [[1, 'type', 'user', 1, 'add']]);
		await adapter.append([2, 2, null], [[1, 'age', 30, 2, 'add']]);

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

		// The checkpoint clears log entries at or below the snapshot's last tx.
		const logStore = fake.databases().get('fatos')?.stores.get('log');
		expect(logStore?.entries().size).toBe(0);

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
		(globalThis as { indexedDB?: unknown }).indexedDB = createFakeIndexedDB();
		const adapter = new IndexedDBAdapter();
		const snapshot = makeRichSnapshot();

		await adapter.save(snapshot);
		// Re-append the last snapshot transaction: it was already checkpointed
		// (crash between checkpoint and log truncate must not double-replay).
		const lastTx = snapshot.transactions[snapshot.transactions.length - 1];
		await adapter.append(lastTx, snapshot.facts.filter((fact) => fact[3] === lastTx[0]));

		const loaded = await adapter.load();
		expect(comparableFacts(loaded.facts)).toEqual(comparableFacts(snapshot.facts));
		expect(loaded.transactions).toEqual(snapshot.transactions);
	});

	it('save-then-append-then-load round-trip preserves transaction order', async () => {
		(globalThis as { indexedDB?: unknown }).indexedDB = createFakeIndexedDB();
		const adapter = new IndexedDBAdapter();

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
		await adapter.append([3, 3, null], [[1, 'name', 'Alice', 3, 'add']]);

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
