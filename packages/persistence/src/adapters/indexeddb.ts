/**
 * IndexedDB adapter — browser client persistence (design/04 persistence).
 *
 * Uses the global `indexedDB` directly; no dependency. The snapshot lives in
 * one object store as a single record `{ payload }` under a fixed key, and an
 * append-only log lives in a second object store keyed by tx (records
 * `{ tx, payload }`). `load()` merges the snapshot with log entries newer than
 * the snapshot's last tx (a checkpoint-then-crash-before-truncate never
 * double-replays); `save()` is the compaction checkpoint — it replaces the
 * snapshot record and clears log entries at or below the snapshot's last tx;
 * `append()` writes one log record per committed transaction (O(transaction
 * size)). The database is opened lazily; `close()` releases the cached
 * connection. In environments without `indexedDB` (e.g. Node without a stub),
 * the adapter throws a descriptive error.
 *
 * The structural types below are a minimal projection of the DOM IndexedDB
 * API — the real browser `indexedDB` satisfies them at runtime; this file
 * compiles under a DOM-less `lib` (ES2020).
 *
 * Values are persisted through the core wire tags (`$ref` / `$date` /
 * `$bigint`), so Date, bigint, and ref values round-trip losslessly.
 */

import type { Fact, TransactionRecord } from '@fatos/core';
import { deserializeLogEntry, deserializeSnapshot, serializeLogEntry, serializeSnapshot } from '../serialization';
import type { DatabaseSnapshot, StorageAdapter } from '../types';

export type IndexedDBAdapterOptions = {
	/** IndexedDB database name. Defaults to `fatos`. */
	databaseName?: string;
	/** Object store holding the snapshot record. Defaults to `snapshot`. */
	storeName?: string;
	/** Key of the snapshot record inside the store. Defaults to `fatos-snapshot`. */
	key?: string;
	/** Object store holding the append-only log, keyed by tx. Defaults to `log`. */
	logStoreName?: string;
};

type IDBRequestLike<T> = {
	onsuccess: ((event: { target: { result: T } }) => void) | null;
	onerror: ((event: { target: { error: Error } }) => void) | null;
};

type IDBOpenRequestLike = IDBRequestLike<IDBDatabaseLike> & {
	onupgradeneeded: ((event: { target: { result: IDBDatabaseLike } }) => void) | null;
};

type IDBObjectStoreLike = {
	get(key: string | number): IDBRequestLike<unknown>;
	getAll(): IDBRequestLike<unknown[]>;
	put(value: unknown, key: string | number): IDBRequestLike<unknown>;
	delete(key: string | number): IDBRequestLike<unknown>;
};

type IDBTransactionLike = {
	objectStore(name: string): IDBObjectStoreLike;
};

type IDBDatabaseLike = {
	objectStoreNames: { contains(name: string): boolean };
	createObjectStore(name: string): IDBObjectStoreLike;
	transaction(storeName: string | readonly string[], mode: 'readonly' | 'readwrite'): IDBTransactionLike;
	close(): void;
};

type IndexedDBLike = {
	open(name: string, version: number): IDBOpenRequestLike;
};

const DEFAULT_DATABASE_NAME = 'fatos';
const DEFAULT_STORE_NAME = 'snapshot';
const DEFAULT_KEY = 'fatos-snapshot';
const DEFAULT_LOG_STORE_NAME = 'log';
const DB_VERSION = 2;

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

/** A log record: `{ tx, payload }`, stored under key `tx`. */
function isLogEntryRecord(value: unknown): value is { tx: number; payload: unknown } {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as { tx?: unknown }).tx === 'number' &&
		'payload' in value
	);
}


export class IndexedDBAdapter implements StorageAdapter {
	private readonly databaseName: string;
	private readonly storeName: string;
	private readonly key: string;
	private readonly logStoreName: string;
	private database: IDBDatabaseLike | null = null;

	constructor(options: IndexedDBAdapterOptions = {}) {
		this.databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME;
		this.storeName = options.storeName ?? DEFAULT_STORE_NAME;
		this.key = options.key ?? DEFAULT_KEY;
		this.logStoreName = options.logStoreName ?? DEFAULT_LOG_STORE_NAME;
	}

	private async open(): Promise<IDBDatabaseLike> {
		if (this.database) {
			return this.database;
		}

		const idb = getIndexedDB();
		const request = idb.open(this.databaseName, DB_VERSION);
		request.onupgradeneeded = (event) => {
			const db = event.target.result;
			if (!db.objectStoreNames.contains(this.storeName)) {
				db.createObjectStore(this.storeName);
			}
			if (!db.objectStoreNames.contains(this.logStoreName)) {
				db.createObjectStore(this.logStoreName);
			}
		};

		const db = await openDatabase(request);
		this.database = db;
		return db;
	}

	private async withStore<T>(
		storeName: string,
		mode: 'readonly' | 'readwrite',
		run: (store: IDBObjectStoreLike) => IDBRequestLike<T>
	): Promise<T> {
		const db = await this.open();
		const transaction = db.transaction(storeName, mode);
		const request = run(transaction.objectStore(storeName));

		return new Promise((resolve, reject) => {
			request.onsuccess = (event) => {
				resolve(event.target.result);
			};
			request.onerror = (event) => {
				reject(event.target.error ?? new Error('IndexedDBAdapter: request failed'));
			};
		});
	}

	/** Runs several requests in one transaction, resolving when all succeed. */
	private async withStoreBatch(
		storeName: string,
		run: (store: IDBObjectStoreLike) => readonly IDBRequestLike<unknown>[]
	): Promise<void> {
		const db = await this.open();
		const transaction = db.transaction(storeName, 'readwrite');
		const requests = run(transaction.objectStore(storeName));

		return new Promise((resolve, reject) => {
			let remaining = requests.length;
			if (remaining === 0) {
				resolve();
				return;
			}

			for (const request of requests) {
				request.onsuccess = () => {
					remaining -= 1;
					if (remaining === 0) {
						resolve();
					}
				};
				request.onerror = (event) => {
					reject(event.target.error ?? new Error('IndexedDBAdapter: request failed'));
				};
			}
		});
	}

	async load(): Promise<DatabaseSnapshot> {
		const result = await this.withStore(this.storeName, 'readonly', (store) => store.get(this.key));
		let snapshot: DatabaseSnapshot;
		if (result === undefined || result === null) {
			snapshot = { facts: [], transactions: [] };
		} else {
			if (typeof result !== 'object' || !('payload' in result)) {
				throw new Error('IndexedDBAdapter: stored snapshot record is malformed');
			}
			snapshot = deserializeSnapshot((result as { payload: unknown }).payload);
		}

		// Replay log entries newer than the snapshot; anything at or below the
		// snapshot's last tx is already inside it (checkpoint-then-crash-before-
		// truncate must never double-replay).
		const maxTx = snapshot.transactions.length > 0 ? snapshot.transactions[snapshot.transactions.length - 1][0] : 0;
		const logEntries = await this.withStore(this.logStoreName, 'readonly', (store) => store.getAll());

		const facts = snapshot.facts.slice();
		const transactions = snapshot.transactions.slice();
		const pending = logEntries
			.filter((entry): entry is { tx: number; payload: unknown } => {
				if (!isLogEntryRecord(entry)) {
					throw new Error('IndexedDBAdapter: stored log entry is malformed');
				}
				return entry.tx > maxTx;
			})
			.sort((a, b) => a.tx - b.tx);

		for (const entry of pending) {
			const parsed = deserializeLogEntry(entry.payload);
			if (parsed.transaction[0] > maxTx) {
				transactions.push(parsed.transaction);
				for (const fact of parsed.facts) {
					facts.push(fact);
				}
			}
		}

		return { facts, transactions };
	}

	/**
	 * Appends one committed transaction (its ledger record plus its facts) as
	 * a single log record keyed by tx. O(transaction size).
	 */
	async append(transaction: TransactionRecord, facts: readonly Fact[]): Promise<void> {
		const payload = serializeLogEntry(transaction, facts);
		await this.withStore(this.logStoreName, 'readwrite', (store) =>
			store.put({ tx: transaction[0], payload }, transaction[0])
		);
	}

	/**
	 * Compaction checkpoint: replaces the snapshot record, then clears log
	 * entries at or below the snapshot's last tx so the log never outlives the
	 * data it duplicates.
	 */
	async save(snapshot: DatabaseSnapshot): Promise<void> {
		const payload = serializeSnapshot(snapshot);
		await this.withStore(this.storeName, 'readwrite', (store) => store.put({ payload }, this.key));

		const maxTx = snapshot.transactions.length > 0 ? snapshot.transactions[snapshot.transactions.length - 1][0] : 0;
		await this.truncateLog(maxTx);
	}

	private async truncateLog(maxTx: number): Promise<void> {
		const entries = await this.withStore(this.logStoreName, 'readonly', (store) => store.getAll());
		const staleKeys: number[] = [];
		for (const entry of entries) {
			if (isLogEntryRecord(entry) && entry.tx <= maxTx) {
				staleKeys.push(entry.tx);
			}
		}
		if (staleKeys.length === 0) {
			return;
		}

		await this.withStoreBatch(this.logStoreName, (store) => staleKeys.map((tx) => store.delete(tx)));
	}

	close(): Promise<void> {
		if (this.database) {
			this.database.close();
			this.database = null;
		}
		return Promise.resolve();
	}
}
