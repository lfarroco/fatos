/**
 * IndexedDB adapter — browser client persistence (design/04 persistence).
 *
 * Uses the global `indexedDB` directly; no dependency. The snapshot lives in
 * one object store as a single record `{ payload }` under a fixed key.
 * `load()`/`save()` open the database lazily; `close()` releases the cached
 * connection. In environments without `indexedDB` (e.g. Node without a stub),
 * `load()`/`save()` throw a descriptive error.
 *
 * The structural types below are a minimal projection of the DOM IndexedDB
 * API — the real browser `indexedDB` satisfies them at runtime; this file
 * compiles under a DOM-less `lib` (ES2020).
 *
 * Values are persisted through the core wire tags (`$ref` / `$date` /
 * `$bigint`), so Date, bigint, and ref values round-trip losslessly.
 */

import { deserializeSnapshot, serializeSnapshot } from '../serialization';
import type { DatabaseSnapshot, StorageAdapter } from '../types';

export type IndexedDBAdapterOptions = {
	/** IndexedDB database name. Defaults to `fatos`. */
	databaseName?: string;
	/** Object store holding the snapshot record. Defaults to `snapshot`. */
	storeName?: string;
	/** Key of the snapshot record inside the store. Defaults to `fatos-snapshot`. */
	key?: string;
};

type IDBRequestLike<T> = {
	onsuccess: ((event: { target: { result: T } }) => void) | null;
	onerror: ((event: { target: { error: Error } }) => void) | null;
};

type IDBOpenRequestLike = IDBRequestLike<IDBDatabaseLike> & {
	onupgradeneeded: ((event: { target: { result: IDBDatabaseLike } }) => void) | null;
};

type IDBObjectStoreLike = {
	get(key: string): IDBRequestLike<unknown>;
	put(value: unknown, key: string): IDBRequestLike<unknown>;
};

type IDBTransactionLike = {
	objectStore(name: string): IDBObjectStoreLike;
};

type IDBDatabaseLike = {
	objectStoreNames: { contains(name: string): boolean };
	createObjectStore(name: string): IDBObjectStoreLike;
	transaction(storeName: string, mode: 'readonly' | 'readwrite'): IDBTransactionLike;
	close(): void;
};

type IndexedDBLike = {
	open(name: string, version: number): IDBOpenRequestLike;
};

const DEFAULT_DATABASE_NAME = 'fatos';
const DEFAULT_STORE_NAME = 'snapshot';
const DEFAULT_KEY = 'fatos-snapshot';

function getIndexedDB(): IndexedDBLike {
	const candidate = (globalThis as { indexedDB?: unknown }).indexedDB;
	if (candidate === undefined || candidate === null) {
		throw new Error('IndexedDBAdapter: indexedDB is not available in this environment');
	}
	return candidate as IndexedDBLike;
}

function openDatabase(request: IDBOpenRequestLike): Promise<IDBDatabaseLike> {
	return new Promise((resolve, reject) => {
		request.onsuccess = (event) => {
			resolve(event.target.result);
		};
		request.onerror = (event) => {
			reject(event.target.error ?? new Error('IndexedDBAdapter: failed to open the database'));
		};
	});
}

export class IndexedDBAdapter implements StorageAdapter {
	private readonly databaseName: string;
	private readonly storeName: string;
	private readonly key: string;
	private database: IDBDatabaseLike | null = null;

	constructor(options: IndexedDBAdapterOptions = {}) {
		this.databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME;
		this.storeName = options.storeName ?? DEFAULT_STORE_NAME;
		this.key = options.key ?? DEFAULT_KEY;
	}

	private async open(): Promise<IDBDatabaseLike> {
		if (this.database) {
			return this.database;
		}

		const idb = getIndexedDB();
		const request = idb.open(this.databaseName, 1);
		request.onupgradeneeded = (event) => {
			const db = event.target.result;
			if (!db.objectStoreNames.contains(this.storeName)) {
				db.createObjectStore(this.storeName);
			}
		};

		const db = await openDatabase(request);
		this.database = db;
		return db;
	}

	private async withStore<T>(
		mode: 'readonly' | 'readwrite',
		run: (store: IDBObjectStoreLike) => IDBRequestLike<T>
	): Promise<T> {
		const db = await this.open();
		const transaction = db.transaction(this.storeName, mode);
		const request = run(transaction.objectStore(this.storeName));

		return new Promise((resolve, reject) => {
			request.onsuccess = (event) => {
				resolve(event.target.result);
			};
			request.onerror = (event) => {
				reject(event.target.error ?? new Error('IndexedDBAdapter: request failed'));
			};
		});
	}

	async load(): Promise<DatabaseSnapshot> {
		const result = await this.withStore('readonly', (store) => store.get(this.key));
		if (result === undefined || result === null) {
			return { facts: [], transactions: [] };
		}

		if (typeof result !== 'object' || !('payload' in result)) {
			throw new Error('IndexedDBAdapter: stored snapshot record is malformed');
		}

		return deserializeSnapshot((result as { payload: unknown }).payload);
	}

	async save(snapshot: DatabaseSnapshot): Promise<void> {
		const payload = serializeSnapshot(snapshot);
		await this.withStore('readwrite', (store) => store.put({ payload }, this.key));
	}

	close(): Promise<void> {
		if (this.database) {
			this.database.close();
			this.database = null;
		}
		return Promise.resolve();
	}
}
