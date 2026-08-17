/**
 * Sync module tests: pure message/log pieces plus the syncing client driven
 * by an injected fake WebSocket (no real socket anywhere).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '@fatos/core';
import type { DatabaseSnapshot, StorageAdapter } from '@fatos/persistence';
import type { Fact, FatosClient, SyncServerMessage, SyncStatus, SyncTransactionEvent, TransactionRecord } from './index';
import { createClient } from './index';
import {
	applyDeltaToClient,
	catchUpDelta,
	createSyncingClient,
	factsToTransactionEntries,
	lastAppliedTx,
	maxTxOf,
	parseSyncMessage,
	SyncingClient
} from './sync';
import type { SyncSocket } from './sync';

type Listener = (event: unknown) => void;

class FakeSocket implements SyncSocket {
	readyState = 0;
	sent: string[] = [];
	private listeners = new Map<string, Set<Listener>>();

	addEventListener(type: string, listener: Listener): void {
		const set = this.listeners.get(type) ?? new Set<Listener>();
		set.add(listener);
		this.listeners.set(type, set);
	}

	removeEventListener(type: string, listener: Listener): void {
		this.listeners.get(type)?.delete(listener);
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		if (this.readyState === 3) {
			return;
		}
		this.readyState = 3;
		this.emit('close', {});
	}

	open(): void {
		this.readyState = 1;
		this.emit('open', {});
	}

	message(data: string): void {
		this.emit('message', { data });
	}

	private emit(type: string, event: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(event);
		}
	}
}

function socketHarness(): { sockets: FakeSocket[]; factory: () => FakeSocket; current: () => FakeSocket } {
	const sockets: FakeSocket[] = [];
	return {
		sockets,
		factory: () => {
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		},
		current: () => sockets[sockets.length - 1]
	};
}

function json(message: unknown): string {
	return JSON.stringify(message);
}

/** Flushes the persist queue (microtask-based). Loops generously so chained
 * queue items all settle regardless of fake-timer microtask draining. */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 20; i += 1) {
		await Promise.resolve();
	}
}

/** In-memory StorageAdapter that records every save/append for assertions. */
class FakeAdapter implements StorageAdapter {
	facts: Fact[] = [];
	transactions: TransactionRecord[] = [];
	saves: DatabaseSnapshot[] = [];
	appends: Array<{ transaction: TransactionRecord; facts: Fact[] }> = [];
	loadCalls = 0;

	constructor(seed?: DatabaseSnapshot) {
		if (seed !== undefined) {
			this.facts = seed.facts.slice();
			this.transactions = seed.transactions.slice();
		}
	}

	async load(): Promise<DatabaseSnapshot> {
		this.loadCalls += 1;
		return { facts: this.facts.slice(), transactions: this.transactions.slice() };
	}

	async save(snapshot: DatabaseSnapshot): Promise<void> {
		this.saves.push({ facts: snapshot.facts.slice(), transactions: snapshot.transactions.slice() });
		this.facts = snapshot.facts.slice();
		this.transactions = snapshot.transactions.slice();
	}

	async append(transaction: TransactionRecord, facts: readonly Fact[]): Promise<void> {
		this.appends.push({ transaction, facts: facts.slice() });
		this.transactions.push(transaction);
		this.facts.push(...facts);
	}

	async close(): Promise<void> {}
}

const synced = (id: string): SyncServerMessage => ({ type: 'synced', id });

const tx1: SyncTransactionEvent = {
	type: 'transaction:committed',
	transaction: [1, 1000, null],
	facts: [[1, 'user/name', 'Alice', 1, 'add']]
};

describe('parseSyncMessage', () => {
	it('parses every frame of the sync protocol', () => {
		expect(parseSyncMessage(json(synced('s1')))).toEqual({ type: 'synced', id: 's1' });
		expect(
			parseSyncMessage(json({ type: 'facts', id: 's1', facts: [[1, 'a', { $date: 0 }, 1, 'add']] }))
		).toEqual({ type: 'facts', id: 's1', facts: [[1, 'a', { $date: 0 }, 1, 'add']] });
		expect(parseSyncMessage(json({ type: 'transactions', id: 's1', transactions: [[2, 2000, { m: 1 }]] }))).toEqual({
			type: 'transactions',
			id: 's1',
			transactions: [[2, 2000, { m: 1 }]]
		});
		expect(
			parseSyncMessage(
				json({
					type: 'snapshot',
					id: 's1',
					facts: [[1, 'a', 'x', 1, 'add']],
					transactions: [[1, 100, null]]
				})
			)
		).toEqual({ type: 'snapshot', id: 's1', facts: [[1, 'a', 'x', 1, 'add']], transactions: [[1, 100, null]] });
		expect(parseSyncMessage(json({ type: 'sync-event', id: 's1', event: tx1 }))).toEqual({
			type: 'sync-event',
			id: 's1',
			event: tx1
		});
	});

	it('rejects malformed frames', () => {
		expect(parseSyncMessage('not json')).toBeNull();
		expect(parseSyncMessage(json({ type: 'synced' }))).toBeNull(); // missing id
		expect(parseSyncMessage(json({ type: 'synced', id: '' }))).toBeNull(); // empty id
		expect(parseSyncMessage(json({ type: 'nope', id: 's1' }))).toBeNull();
		expect(parseSyncMessage(json({ type: 'facts', id: 's1', facts: [[1, 'a', 'x', 'bad', 'add']] }))).toBeNull();
		expect(
			parseSyncMessage(json({ type: 'snapshot', id: 's1', facts: 'nope', transactions: [] }))
		).toBeNull();
		expect(parseSyncMessage(json({ type: 'transactions', id: 's1', transactions: [[1, 'x', null]] }))).toBeNull();
		expect(
			parseSyncMessage(json({ type: 'sync-event', id: 's1', event: { type: 'facts', transaction: tx1.transaction, facts: tx1.facts } }))
		).toBeNull();
		expect(
			parseSyncMessage(json({ type: 'sync-event', id: 's1', event: { type: 'transaction:committed', transaction: [1, 1000, null], facts: 'nope' } }))
		).toBeNull();
	});
});
describe('factsToTransactionEntries', () => {
	it('keeps data facts as mutations', () => {
		const facts: Fact[] = [
			[1, 'user/name', 'Alice', 1, 'add'],
			[1, 'user/name', 'Alice', 2, 'retract']
		];
		expect(factsToTransactionEntries(facts)).toEqual([
			['add', 1, 'user/name', 'Alice'],
			['retract', 1, 'user/name', 'Alice']
		]);
	});

	it('reconstructs schema declarations from schema facts, declarations first', () => {
		const facts: Fact[] = [
			[1, 'user/name', 'Alice', 1, 'add'],
			[-1, 'db/ident', 'user/name', 1, 'add'],
			[-1, 'db/valueType', 'string', 1, 'add'],
			[-1, 'db/cardinality', 'one', 1, 'add'],
			[-2, 'db/ident', 'user/manager', 1, 'add'],
			[-2, 'db/valueType', 'ref', 1, 'add'],
			[-2, 'db/cardinality', 'one', 1, 'add'],
			[-2, 'db/ref', true, 1, 'add'],
			[-3, 'db/ident', 'user/email', 1, 'add'],
			[-3, 'db/valueType', 'string', 1, 'add'],
			[-3, 'db/cardinality', 'one', 1, 'add'],
			[-3, 'db/unique', 'identity', 1, 'add']
		];

		expect(factsToTransactionEntries(facts)).toEqual([
			{ ident: 'user/name', valueType: 'string', cardinality: 'one' },
			{ ident: 'user/manager', valueType: 'ref', cardinality: 'one', ref: true },
			{ ident: 'user/email', valueType: 'string', cardinality: 'one', unique: 'identity' },
			['add', 1, 'user/name', 'Alice']
		]);
	});

	it('routes retracted schema facts as mutations (defensive)', () => {
		const facts: Fact[] = [[-1, 'db/unique', 'identity', 1, 'retract']];
		expect(factsToTransactionEntries(facts)).toEqual([['retract', -1, 'db/unique', 'identity']]);
	});
});

describe('log helpers', () => {
	const log = {
		facts: [
			[1, 'a', 'x', 1, 'add'],
			[1, 'b', 'y', 3, 'add']
		],
		transactions: [
			[1, 100, null],
			[3, 300, null]
		]
	};

	it('computes watermarks from the ledger and the whole log', () => {
		expect(lastAppliedTx(log)).toBe(3);
		expect(maxTxOf(log)).toBe(3);
		expect(lastAppliedTx({ facts: [], transactions: [] })).toBeNull();
		expect(maxTxOf({ facts: [], transactions: [] })).toBeNull();
	});

	it('keeps only the delta after a tx', () => {
		expect(catchUpDelta(log, 1)).toEqual({
			facts: [log.facts[1]],
			transactions: [log.transactions[1]]
		});
	});
});

describe('applyDeltaToClient', () => {
	function clientWith(
		facts: Fact[],
		transactions: [number, number, Record<string, unknown> | null][] = [[1, 100, null]]
	): ReturnType<typeof createClient> {
		const db = createDatabase();
		db.restore({ facts, transactions });
		return createClient(db);
	}

	it('replays a delta onto a client, preserving tx numbering', () => {
		const client = clientWith([[1, 'user/name', 'Alice', 1, 'add']]);
		const result = applyDeltaToClient(client, {
			facts: [
				[1, 'user/name', 'Alicia', 2, 'add'],
				[1, 'user/age', 30, 3, 'add']
			],
			transactions: [
				[2, 200, null],
				[3, 300, null]
			]
		});

		expect(result.error).toBeUndefined();
		expect(result.lastApplied).toBe(3);
		expect(client.getFacts()).toEqual([
			[1, 'user/name', 'Alice', 1, 'add'],
			[1, 'user/name', 'Alicia', 2, 'add'],
			[1, 'user/age', 30, 3, 'add']
		]);
	});

	it('stops at a failing transaction and reports the last success', () => {
		const client = clientWith([
			[-1, 'db/ident', 'user/name', 1, 'add'],
			[-1, 'db/valueType', 'string', 1, 'add'],
			[-1, 'db/cardinality', 'one', 1, 'add'],
			[1, 'user/name', 'Alice', 1, 'add']
		]);

		const result = applyDeltaToClient(client, {
			facts: [
				[1, 'user/age', 30, 2, 'add'],
				// tx 3 violates the one-cardinality constraint without a retract.
				[1, 'user/name', 'Bob', 3, 'add']
			],
			transactions: [
				[2, 200, null],
				[3, 300, null]
			]
		});

		expect(result.lastApplied).toBe(2);
		expect(result.error).toBeDefined();
		expect(result.error?.message).toContain('Cardinality conflict');
	});
});

describe('createSyncingClient (fake socket)', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('full syncs on connect, applies live events, and re-syncs with afterTx on reconnect', () => {
		vi.useFakeTimers();
		const harness = socketHarness();
		const statuses: SyncStatus[] = [];
		const errors: Error[] = [];

		const syncing = createSyncingClient({
			url: 'ws://test/ws',
			createSocket: harness.factory,
			reconnectDelayMs: 10,
			onStatusChange: (status) => statuses.push(status),
			onError: (error) => errors.push(error)
		});
		syncing.start();
		const socket = harness.current();
		expect(syncing.getStatus()).toBe('connecting');

		socket.open();
		expect(JSON.parse(socket.sent[0] as string)).toEqual({ type: 'sync', id: syncing.id });

		socket.message(json(synced(syncing.id)));
		socket.message(json({ type: 'facts', id: syncing.id, facts: [[1, 'user/name', 'Alice', 1, 'add']] }));
		socket.message(json({ type: 'transactions', id: syncing.id, transactions: [[1, 1000, null]] }));

		expect(syncing.client.getFacts()).toEqual([[1, 'user/name', 'Alice', 1, 'add']]);
		expect(syncing.getLastAppliedTx()).toBe(1);
		expect(syncing.getStatus()).toBe('synced');
		expect(statuses).toContain('synced');

		// Live event applies to the same client instance.
		const stableClient = syncing.client;
		socket.message(
			json({
				type: 'sync-event',
				id: syncing.id,
				event: {
					type: 'transaction:committed',
					transaction: [2, 2000, { source: 'live' }],
					facts: [[1, 'user/age', 30, 2, 'add']]
				}
			})
		);
		expect(syncing.client).toBe(stableClient);
		expect(syncing.client.getFacts()).toHaveLength(2);
		expect(syncing.client.entity(1)).toEqual({ id: 1, 'user/name': 'Alice', 'user/age': 30 });
		expect(syncing.getLastAppliedTx()).toBe(2);

		// Drop the connection: the next connect re-syncs from the watermark.
		socket.close();
		vi.advanceTimersByTime(10);

		const socket2 = harness.current();
		expect(syncing.getStatus()).toBe('reconnecting');
		socket2.open();
		expect(JSON.parse(socket2.sent[0] as string)).toEqual({ type: 'sync', id: syncing.id, afterTx: 2 });

		socket2.message(json(synced(syncing.id)));
		socket2.message(json({ type: 'facts', id: syncing.id, facts: [[1, 'user/name', 'Alicia', 3, 'add']] }));
		socket2.message(json({ type: 'transactions', id: syncing.id, transactions: [[3, 3000, null]] }));

		// Incremental catch-up: same client instance, delta merged in.
		expect(syncing.client).toBe(stableClient);
		expect(syncing.client.getFacts()).toHaveLength(3);
		expect(syncing.client.entity(1)).toEqual({ id: 1, 'user/name': 'Alicia', 'user/age': 30 });
		expect(syncing.getLastAppliedTx()).toBe(3);
		expect(errors).toEqual([]);

		syncing.stop();
		expect(syncing.getStatus()).toBe('stopped');
	});

	it('sends afterTime on the first connect, then reconnects from the watermark', () => {
		vi.useFakeTimers();
		const harness = socketHarness();
		const errors: Error[] = [];
		const syncing = createSyncingClient({
			url: 'ws://test/ws',
			createSocket: harness.factory,
			reconnectDelayMs: 10,
			afterTime: 1_500,
			onError: (error) => errors.push(error)
		});
		syncing.start();
		const socket = harness.current();
		socket.open();
		expect(JSON.parse(socket.sent[0] as string)).toEqual({
			type: 'sync',
			id: syncing.id,
			afterTime: 1_500
		});

		// Complete the afterTime catch-up: the mirror is rebuilt from the
		// streamed delta and the watermark becomes the streamed ledger head.
		socket.message(json(synced(syncing.id)));
		socket.message(json({ type: 'facts', id: syncing.id, facts: [[2, 'user/age', 20, 2, 'add']] }));
		socket.message(json({ type: 'transactions', id: syncing.id, transactions: [[2, 2000, null]] }));
		expect(syncing.client.getFacts()).toEqual([[2, 'user/age', 20, 2, 'add']]);
		expect(syncing.getLastAppliedTx()).toBe(2);

		// Reconnect: the tx watermark wins over afterTime.
		socket.close();
		vi.advanceTimersByTime(10);
		const socket2 = harness.current();
		socket2.open();
		expect(JSON.parse(socket2.sent[0] as string)).toEqual({ type: 'sync', id: syncing.id, afterTx: 2 });
		expect(errors).toEqual([]);

		syncing.stop();
	});

	it('resumes incrementally from a pre-populated client ledger (no full pull)', () => {
		const db = createDatabase();
		db.transact([['add', 1, 'user/name', 'Alice']]); // ledger head = 1
		const seeded = createClient(db);

		const harness = socketHarness();
		const replaced: FatosClient[] = [];
		const syncing = createSyncingClient({
			url: 'ws://test/ws',
			createSocket: harness.factory,
			client: seeded,
			// Configured, but the restored ledger head takes precedence.
			afterTime: 500,
			onClientReplaced: (client) => replaced.push(client)
		});
		syncing.start();
		const socket = harness.current();
		socket.open();

		// First connect is an incremental sync from the ledger head — the
		// server streams a delta, not a snapshot, so no client replacement.
		expect(JSON.parse(socket.sent[0] as string)).toEqual({ type: 'sync', id: syncing.id, afterTx: 1 });

		socket.message(json(synced(syncing.id)));
		socket.message(json({ type: 'facts', id: syncing.id, facts: [[1, 'user/name', 'Alicia', 2, 'add']] }));
		socket.message(json({ type: 'transactions', id: syncing.id, transactions: [[2, 2000, null]] }));

		expect(syncing.client).toBe(seeded);
		expect(replaced).toEqual([]);
		expect(syncing.client.getFacts()).toEqual([
			[1, 'user/name', 'Alice', 1, 'add'],
			[1, 'user/name', 'Alicia', 2, 'add']
		]);
		expect(syncing.getLastAppliedTx()).toBe(2);

		syncing.stop();
	});

	it('full-pulls when the provided client is empty', () => {
		const harness = socketHarness();
		const syncing = createSyncingClient({
			url: 'ws://test/ws',
			createSocket: harness.factory,
			client: createClient()
		});
		syncing.start();
		const socket = harness.current();
		socket.open();

		// No ledger → no watermark → full pull (no afterTx / afterTime).
		expect(JSON.parse(socket.sent[0] as string)).toEqual({ type: 'sync', id: syncing.id });

		socket.message(json(synced(syncing.id)));
		socket.message(
			json({
				type: 'snapshot',
				id: syncing.id,
				facts: [[1, 'user/name', 'Alice', 1, 'add']],
				transactions: [[1, 1000, null]]
			})
		);
		expect(syncing.getLastAppliedTx()).toBe(1);

		syncing.stop();
	});

	it('persists applied transactions to an injected adapter', async () => {
		vi.useFakeTimers();
		const adapter = new FakeAdapter();
		const harness = socketHarness();
		const errors: Error[] = [];
		const syncing = createSyncingClient({
			url: 'ws://test/ws',
			createSocket: harness.factory,
			reconnectDelayMs: 10,
			adapter,
			onError: (error) => errors.push(error)
		});
		syncing.start();
		const socket = harness.current();
		socket.open();

		// Full pull → the cache is replaced with the restored mirror.
		socket.message(json(synced(syncing.id)));
		socket.message(
			json({
				type: 'snapshot',
				id: syncing.id,
				facts: [
					[1, 'user/name', 'Alice', 1, 'add'],
					[2, 'user/age', 30, 2, 'add']
				],
				transactions: [
					[1, 1000, null],
					[2, 2000, null]
				]
			})
		);
		await flushMicrotasks();
		expect(adapter.saves).toHaveLength(1);
		expect(adapter.saves[0]).toEqual({
			facts: [
				[1, 'user/name', 'Alice', 1, 'add'],
				[2, 'user/age', 30, 2, 'add']
			],
			transactions: [
				[1, 1000, null],
				[2, 2000, null]
			]
		});

		// Live sync-event → appended with its facts (metadata revived).
		socket.message(
			json({
				type: 'sync-event',
				id: syncing.id,
				event: {
					type: 'transaction:committed',
					transaction: [3, 3000, { source: 'live' }],
					facts: [[1, 'user/name', 'Alicia', 3, 'add']]
				}
			})
		);
		await flushMicrotasks();
		expect(adapter.appends).toHaveLength(1);
		expect(adapter.appends[0]).toEqual({
			transaction: [3, 3000, { source: 'live' }],
			facts: [[1, 'user/name', 'Alicia', 3, 'add']]
		});

		// Incremental catch-up on reconnect → one append per delta transaction.
		socket.close();
		vi.advanceTimersByTime(10);
		const socket2 = harness.current();
		socket2.open();
		socket2.message(json(synced(syncing.id)));
		socket2.message(
			json({
				type: 'facts',
				id: syncing.id,
				facts: [
					[1, 'user/name', 'Alicia2', 4, 'add'],
					[2, 'user/age', 31, 5, 'add']
				]
			})
		);
		socket2.message(
			json({
				type: 'transactions',
				id: syncing.id,
				transactions: [
					[4, 4000, null],
					[5, 5000, null]
				]
			})
		);
		await flushMicrotasks();
		expect(adapter.appends).toHaveLength(3);
		expect(adapter.appends[1]).toEqual({
			transaction: [4, 4000, null],
			facts: [[1, 'user/name', 'Alicia2', 4, 'add']]
		});
		expect(adapter.appends[2]).toEqual({
			transaction: [5, 5000, null],
			facts: [[2, 'user/age', 31, 5, 'add']]
		});
		expect(errors).toEqual([]);

		syncing.stop();
	});

	it('seeds the mirror from a cache adapter and resumes with its watermark', async () => {
		const adapter = new FakeAdapter({
			facts: [
				[1, 'user/name', 'Alice', 1, 'add'],
				[2, 'user/age', 30, 2, 'add']
			],
			transactions: [
				[1, 1000, null],
				[2, 2000, null]
			]
		});
		const harness = socketHarness();
		const replaced: FatosClient[] = [];
		const syncing = createSyncingClient({
			url: 'ws://test/ws',
			createSocket: harness.factory,
			adapter,
			onClientReplaced: (client) => replaced.push(client)
		});
		syncing.start();
		const socket = harness.current();
		socket.open();

		// Seeding is async (adapter.load()): the sync message is deferred until
		// the cache is restored, then sent with the cache ledger head.
		await flushMicrotasks();
		expect(syncing.getLastAppliedTx()).toBe(2);
		expect(syncing.client.getFacts()).toEqual([
			[1, 'user/name', 'Alice', 1, 'add'],
			[2, 'user/age', 30, 2, 'add']
		]);
		expect(replaced).toHaveLength(1);
		expect(JSON.parse(socket.sent[0] as string)).toEqual({ type: 'sync', id: syncing.id, afterTx: 2 });

		syncing.stop();
	});

	it('full-pulls when the cache adapter holds nothing', async () => {
		const adapter = new FakeAdapter();
		const harness = socketHarness();
		const replaced: FatosClient[] = [];
		const syncing = createSyncingClient({
			url: 'ws://test/ws',
			createSocket: harness.factory,
			adapter,
			onClientReplaced: (client) => replaced.push(client)
		});
		syncing.start();
		const socket = harness.current();
		socket.open();

		await flushMicrotasks();
		expect(replaced).toEqual([]);
		expect(adapter.loadCalls).toBe(1);
		// No cache → no watermark → full pull.
		expect(JSON.parse(socket.sent[0] as string)).toEqual({ type: 'sync', id: syncing.id });

		syncing.stop();
	});

	it('a provided client wins over the cache adapter (no seeding)', async () => {
		const db = createDatabase();
		db.transact([['add', 1, 'user/name', 'Alice']]);
		const adapter = new FakeAdapter({
			facts: [[2, 'user/name', 'Cache', 2, 'add']],
			transactions: [[2, 2000, null]]
		});
		const harness = socketHarness();
		const syncing = createSyncingClient({
			url: 'ws://test/ws',
			createSocket: harness.factory,
			client: createClient(db),
			adapter
		});
		syncing.start();
		const socket = harness.current();
		socket.open();

		await flushMicrotasks();
		expect(adapter.loadCalls).toBe(0);
		// The provided client's ledger head drives the first sync.
		expect(JSON.parse(socket.sent[0] as string)).toEqual({ type: 'sync', id: syncing.id, afterTx: 1 });
		expect(syncing.client.getFacts()).toEqual([[1, 'user/name', 'Alice', 1, 'add']]);

		syncing.stop();
	});

	it('reports malformed frames without throwing', () => {
		const harness = socketHarness();
		const errors: Error[] = [];
		const syncing = createSyncingClient({
			url: 'ws://test/ws',
			createSocket: harness.factory,
			onError: (error) => errors.push(error)
		});
		syncing.start();
		const socket = harness.current();
		socket.open();
		socket.message('this is not json');
		socket.message(json({ type: 'synced', id: 'some-other-id' }));

		expect(errors).toHaveLength(2);
		syncing.stop();
	});

	it('restores schema facts on the initial full pull', () => {
		const harness = socketHarness();
		const syncing = createSyncingClient({
			url: 'ws://test/ws',
			createSocket: harness.factory
		});
		syncing.start();
		const socket = harness.current();
		socket.open();

		socket.message(json(synced(syncing.id)));
		socket.message(
			json({
				type: 'facts',
				id: syncing.id,
				facts: [
					[-1, 'db/ident', 'user/name', 1, 'add'],
					[-1, 'db/valueType', 'string', 1, 'add'],
					[-1, 'db/cardinality', 'one', 1, 'add'],
					[1, 'user/name', 'Alice', 1, 'add']
				]
			})
		);
		socket.message(json({ type: 'transactions', id: syncing.id, transactions: [[1, 1000, null]] }));

		expect(syncing.client.getSchemas().map((schema) => schema.ident)).toEqual(['user/name']);
		// The schema constraint is live: a second value without a retract fails.
		expect(() => syncing.client.add(1, 'user/name', 'Bob')).toThrow(/Cardinality conflict/);
		syncing.stop();
	});

	it('falls back to a full pull (client replaced) after an incremental apply failure', () => {
		vi.useFakeTimers();
		const harness = socketHarness();
		const errors: Error[] = [];
		const replaced: unknown[] = [];
		const syncing = createSyncingClient({
			url: 'ws://test/ws',
			createSocket: harness.factory,
			reconnectDelayMs: 10,
			onError: (error) => errors.push(error),
			onClientReplaced: (client) => replaced.push(client)
		});
		syncing.start();
		const socket = harness.current();
		socket.open();
		socket.message(json(synced(syncing.id)));
		socket.message(
			json({
				type: 'facts',
				id: syncing.id,
				facts: [
					[-1, 'db/ident', 'user/name', 1, 'add'],
					[-1, 'db/valueType', 'string', 1, 'add'],
					[-1, 'db/cardinality', 'one', 1, 'add'],
					[1, 'user/name', 'Alice', 1, 'add']
				]
			})
		);
		socket.message(json({ type: 'transactions', id: syncing.id, transactions: [[1, 1000, null]] }));
		expect(syncing.getLastAppliedTx()).toBe(1);

		// A live event that violates the one-cardinality constraint fails to apply.
		const before = syncing.client;
		socket.message(
			json({
				type: 'sync-event',
				id: syncing.id,
				event: {
					type: 'transaction:committed',
					transaction: [2, 2000, null],
					facts: [[1, 'user/name', 'Bob', 2, 'add']]
				}
			})
		);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toContain('live apply failed');

		// Reconnect without afterTx: full pull rebuilds a fresh client. The
		// initial connect also rebuilt (that is the full-pull path), so the
		// second replacement is the one this fallback produced.
		vi.advanceTimersByTime(10);
		const socket2 = harness.current();
		socket2.open();
		expect(JSON.parse(socket2.sent[0] as string)).toEqual({ type: 'sync', id: syncing.id });
		socket2.message(json(synced(syncing.id)));
		socket2.message(
			json({
				type: 'facts',
				id: syncing.id,
				facts: [
					[-1, 'db/ident', 'user/name', 1, 'add'],
					[-1, 'db/valueType', 'string', 1, 'add'],
					[-1, 'db/cardinality', 'one', 1, 'add'],
					[1, 'user/name', 'Alice', 1, 'add'],
					[1, 'user/name', 'Bob', 2, 'add']
				]
			})
		);
		socket2.message(json({ type: 'transactions', id: syncing.id, transactions: [[1, 1000, null], [2, 2000, null]] }));

		expect(replaced).toHaveLength(2);
		expect(replaced[1]).toBe(syncing.client);
		expect(syncing.client).not.toBe(before);
		expect(syncing.client.getFacts()).toHaveLength(5);
		expect(syncing.getLastAppliedTx()).toBe(2);
		syncing.stop();
	});

	it('keeps the client instance on stop/start cycles', () => {
		const harness = socketHarness();
		const syncing = createSyncingClient({
			url: 'ws://test/ws',
			createSocket: harness.factory
		});
		syncing.start();
		const socket = harness.current();
		const firstClient = syncing.client;
		expect(socket.sent).toHaveLength(0); // nothing sent before open
		syncing.stop();
		syncing.start();
		expect(syncing.client).toBe(firstClient);
		expect(syncing.getStatus()).toBe('connecting');
		syncing.stop();
	});

	it('exposes the SyncingClient class and id', () => {
		const syncing = new SyncingClient({ url: 'ws://test/ws' });
		expect(syncing.id).toMatch(/^sync-/);
		expect(syncing.getLastAppliedTx()).toBeNull();
		expect(syncing.getStatus()).toBe('idle');
	});
});

describe('snapshot catch-up', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('applies a snapshot frame from a fresh sync, mirroring current state with schema intact', () => {
		const harness = socketHarness();
		const syncing = createSyncingClient({
			url: 'ws://test/ws',
			createSocket: harness.factory
		});
		syncing.start();
		const socket = harness.current();
		socket.open();
		socket.message(json(synced(syncing.id)));

		// The server's history spans txs 1-5; only the facts still asserted in
		// the current state are in the frame, and the ledger is the full one
		// (txs 4-5 hold only retractions, so they have no snapshot facts).
		socket.message(
			json({
				type: 'snapshot',
				id: syncing.id,
				facts: [
					[-1, 'db/ident', 'user/name', 1, 'add'],
					[-1, 'db/valueType', 'string', 1, 'add'],
					[-1, 'db/cardinality', 'one', 1, 'add'],
					[1, 'user/name', 'Alicia', 2, 'add'],
					[3, 'user/born', { $date: 1_700_000_000_000 }, 3, 'add']
				],
				transactions: [
					[1, 1000, null],
					[2, 2000, null],
					[3, 3000, null],
					[4, 4000, { m: 1 }],
					[5, 5000, null]
				]
			})
		);

		// State matches the server's current state (retracted triples gone,
		// wire tags revived), the schema survives verbatim and stays live, and
		// the watermark is the FULL ledger head, not the trimmed subset's.
		expect(syncing.client.getFacts()).toEqual([
			[-1, 'db/ident', 'user/name', 1, 'add'],
			[-1, 'db/valueType', 'string', 1, 'add'],
			[-1, 'db/cardinality', 'one', 1, 'add'],
			[1, 'user/name', 'Alicia', 2, 'add'],
			[3, 'user/born', new Date(1_700_000_000_000), 3, 'add']
		]);
		expect(syncing.client.entity(1)).toEqual({ id: 1, 'user/name': 'Alicia' });
		expect(syncing.client.entity(3)).toEqual({ id: 3, 'user/born': new Date(1_700_000_000_000) });
		expect(syncing.client.entity(2)).toBeNull();
		expect(syncing.client.getSchemas().map((schema) => schema.ident)).toEqual(['user/name']);
		expect(() => syncing.client.add(1, 'user/name', 'Bob')).toThrow(/Cardinality conflict/);
		expect(syncing.getLastAppliedTx()).toBe(5);
		syncing.stop();
	});

	it('applies live events after a snapshot and reconnects from the real watermark', () => {
		vi.useFakeTimers();
		const harness = socketHarness();
		const errors: Error[] = [];
		const syncing = createSyncingClient({
			url: 'ws://test/ws',
			createSocket: harness.factory,
			reconnectDelayMs: 10,
			onError: (error) => errors.push(error)
		});
		syncing.start();
		const socket = harness.current();
		socket.open();
		socket.message(json(synced(syncing.id)));
		socket.message(
			json({
				type: 'snapshot',
				id: syncing.id,
				facts: [
					[-1, 'db/ident', 'user/name', 1, 'add'],
					[-1, 'db/valueType', 'string', 1, 'add'],
					[-1, 'db/cardinality', 'one', 1, 'add'],
					[1, 'user/name', 'Alicia', 2, 'add']
				],
				transactions: [
					[1, 1000, null],
					[2, 2000, null],
					[3, 3000, null]
				]
			})
		);
		expect(syncing.getLastAppliedTx()).toBe(3);

		// Live event at the server's next tx applies to the same client.
		const stableClient = syncing.client;
		socket.message(
			json({
				type: 'sync-event',
				id: syncing.id,
				event: {
					type: 'transaction:committed',
					transaction: [4, 4000, null],
					facts: [[2, 'user/name', 'Bob', 4, 'add']]
				}
			})
		);
		expect(syncing.client).toBe(stableClient);
		expect(syncing.client.entity(2)).toEqual({ id: 2, 'user/name': 'Bob' });
		expect(syncing.getLastAppliedTx()).toBe(4);

		// Reconnect catches up from the true server head (4), not the subset max.
		socket.close();
		vi.advanceTimersByTime(10);
		const socket2 = harness.current();
		socket2.open();
		expect(JSON.parse(socket2.sent[0] as string)).toEqual({ type: 'sync', id: syncing.id, afterTx: 4 });
		expect(errors).toEqual([]);
		syncing.stop();
	});
});


describe('chunked catch-up', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('accumulates a full pull split across two facts frames', () => {
		const harness = socketHarness();
		const syncing = createSyncingClient({
			url: 'ws://test/ws',
			createSocket: harness.factory
		});
		syncing.start();
		const socket = harness.current();
		socket.open();
		socket.message(json(synced(syncing.id)));

		// Facts spanning tx 1..3 arrive in two 'facts' frames, then the ledger.
		socket.message(
			json({
				type: 'facts',
				id: syncing.id,
				facts: [
					[1, 'user/name', 'Alice', 1, 'add'],
					[1, 'user/age', 30, 2, 'add']
				]
			})
		);
		socket.message(json({ type: 'facts', id: syncing.id, facts: [[2, 'type', 'admin', 3, 'add']] }));
		socket.message(
			json({
				type: 'transactions',
				id: syncing.id,
				transactions: [
					[1, 1000, null],
					[2, 2000, null],
					[3, 3000, null]
				]
			})
		);

		expect(syncing.client.getFacts()).toEqual([
			[1, 'user/name', 'Alice', 1, 'add'],
			[1, 'user/age', 30, 2, 'add'],
			[2, 'type', 'admin', 3, 'add']
		]);
		expect(syncing.getLastAppliedTx()).toBe(3);
		syncing.stop();
	});

	it('accumulates a reconnect incremental catch-up split across two facts frames', () => {
		vi.useFakeTimers();
		const harness = socketHarness();
		const errors: Error[] = [];
		const syncing = createSyncingClient({
			url: 'ws://test/ws',
			createSocket: harness.factory,
			reconnectDelayMs: 10,
			onError: (error) => errors.push(error)
		});
		syncing.start();

		// Initial full pull with a single-facts frame (tx 1).
		const socket = harness.current();
		socket.open();
		socket.message(json(synced(syncing.id)));
		socket.message(json({ type: 'facts', id: syncing.id, facts: [[1, 'user/name', 'Alice', 1, 'add']] }));
		socket.message(json({ type: 'transactions', id: syncing.id, transactions: [[1, 1000, null]] }));
		const stableClient = syncing.client;
		expect(syncing.getLastAppliedTx()).toBe(1);

		// Drop the connection: the next connect re-syncs from the watermark.
		socket.close();
		vi.advanceTimersByTime(10);
		const socket2 = harness.current();
		expect(syncing.getStatus()).toBe('reconnecting');
		socket2.open();
		expect(JSON.parse(socket2.sent[0] as string)).toEqual({ type: 'sync', id: syncing.id, afterTx: 1 });

		// Chunked catch-up: tx 2 and tx 3 facts arrive in two 'facts' frames.
		socket2.message(json(synced(syncing.id)));
		socket2.message(json({ type: 'facts', id: syncing.id, facts: [[1, 'user/age', 30, 2, 'add']] }));
		socket2.message(json({ type: 'facts', id: syncing.id, facts: [[1, 'user/name', 'Alicia', 3, 'add']] }));
		socket2.message(
			json({
				type: 'transactions',
				id: syncing.id,
				transactions: [
					[2, 2000, null],
					[3, 3000, null]
				]
			})
		);

		// Incremental catch-up: same client instance, both frames merged in.
		expect(syncing.client).toBe(stableClient);
		expect(syncing.client.getFacts()).toEqual([
			[1, 'user/name', 'Alice', 1, 'add'],
			[1, 'user/age', 30, 2, 'add'],
			[1, 'user/name', 'Alicia', 3, 'add']
		]);
		expect(syncing.getLastAppliedTx()).toBe(3);
		expect(errors).toEqual([]);
		syncing.stop();
	});
});

function fetchHarness(): {
	calls: Array<{ url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }>;
	respond(ok: boolean, status: number, body: unknown): void;
	rejectWith(error: Error): void;
	fetch: typeof fetch;
} {
	const calls: Array<{ url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }> = [];
	let next: { ok: boolean; status: number; body: unknown } = { ok: true, status: 200, body: {} };
	let rejectNext: Error | null = null;
	return {
		calls,
		respond(ok: boolean, status: number, body: unknown): void {
			next = { ok, status, body };
		},
		rejectWith(error: Error): void {
			rejectNext = error;
		},
		fetch: (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
			calls.push({ url, init });
			if (rejectNext !== null) {
				const error = rejectNext;
				rejectNext = null;
				throw error;
			}
			return {
				ok: next.ok,
				status: next.status,
				json: async (): Promise<unknown> => next.body,
				text: async (): Promise<string> => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body))
			};
		}) as unknown as typeof fetch
	};
}

describe('SyncingClient write-through (G3)', () => {
	it('POSTs { entries, metadata } to the derived HTTP base and revives the response', async () => {
		const harness = socketHarness();
		const fake = fetchHarness();
		const syncing = createSyncingClient({
			url: 'ws://test/ws',
			createSocket: harness.factory,
			fetch: fake.fetch
		});
		fake.respond(true, 200, {
			facts: [
				[1, 'user/name', 'Alice', 1, 'add'],
				[1, 'user/born', { $date: 0 }, 1, 'add']
			],
			transaction: [1, 1000, { source: { $date: 1000 } }]
		});

		const result = await syncing.transact([['add', 1, 'user/name', 'Alice']], { source: 'test' });

		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0]?.url).toBe('http://test/transact');
		expect(fake.calls[0]?.init?.method).toBe('POST');
		expect(fake.calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
		expect(JSON.parse(fake.calls[0]?.init?.body ?? '')).toEqual({
			entries: [['add', 1, 'user/name', 'Alice']],
			metadata: { source: 'test' }
		});
		expect(result.facts[0]?.[2]).toBe('Alice');
		expect(result.facts[1]?.[2]).toEqual(new Date(0));
		expect(result.transaction?.[2]).toEqual({ source: new Date(1000) });
	});

	it('binds the default globalThis.fetch so a bare call does not throw Illegal invocation', async () => {
		// Browser regression: `window.fetch` throws "Failed to execute 'fetch'
		// on 'Window': Illegal invocation" when called with `this` detached from
		// the global object. The default must be bound to globalThis.
		const harness = socketHarness();
		const originalFetch = globalThis.fetch;
		let invokedWith: unknown = null;
		globalThis.fetch = (function (this: unknown, url: string, init?: unknown): Promise<Response> {
			invokedWith = this;
			return Promise.resolve({
				ok: true,
				status: 200,
				json: async (): Promise<unknown> => ({}),
				text: async (): Promise<string> => ''
			} as Response);
		}) as unknown as typeof fetch;

		try {
			const syncing = createSyncingClient({
				url: 'ws://test/ws',
				createSocket: harness.factory
			});
			await syncing.transact([['add', 1, 'a', 'x']]);
			expect(invokedWith).toBe(globalThis);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('uses an injected fetch verbatim (no rebinding)', async () => {
		const harness = socketHarness();
		const fake = fetchHarness();
		const syncing = createSyncingClient({
			url: 'ws://test/ws',
			createSocket: harness.factory,
			fetch: fake.fetch
		});
		fake.respond(true, 200, { facts: [], transaction: null });

		await syncing.transact([['add', 1, 'a', 'x']]);
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0]?.url).toBe('http://test/transact');
	});

	it('wire-tags entry values before POST', async () => {
		const harness = socketHarness();
		const fake = fetchHarness();
		const syncing = createSyncingClient({
			url: 'ws://test/ws',
			createSocket: harness.factory,
			fetch: fake.fetch
		});
		fake.respond(true, 200, {});

		await syncing.transact([['add', 1, 'created', new Date(123)]], { m: 1 });

		expect(JSON.parse(fake.calls[0]?.init?.body ?? '')).toEqual({
			entries: [['add', 1, 'created', { $date: 123 }]],
			metadata: { m: 1 }
		});
	});

	it('add() and retract() POST the right mutation entries', async () => {
		const harness = socketHarness();
		const fake = fetchHarness();
		const syncing = createSyncingClient({
			url: 'ws://test/ws',
			createSocket: harness.factory,
			fetch: fake.fetch
		});

		await syncing.add(1, 'a', 'x');
		await syncing.retract(1, 'a', 'x');

		expect(fake.calls).toHaveLength(2);
		expect(JSON.parse(fake.calls[0]?.init?.body ?? '')).toEqual({
			entries: [['add', 1, 'a', 'x']],
			metadata: undefined
		});
		expect(JSON.parse(fake.calls[1]?.init?.body ?? '')).toEqual({
			entries: [['retract', 1, 'a', 'x']],
			metadata: undefined
		});
	});

	it('rejects on HTTP failure and surfaces the error via onError', async () => {
		const harness = socketHarness();
		const fake = fetchHarness();
		const errors: Error[] = [];
		const syncing = createSyncingClient({
			url: 'ws://test/ws',
			createSocket: harness.factory,
			fetch: fake.fetch,
			onError: (error) => errors.push(error)
		});
		fake.respond(false, 400, 'boom');

		await expect(syncing.transact([['add', 1, 'a', 'x']])).rejects.toThrow(/sync write failed: 400 boom/);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toContain('boom');
	});

	it('rejects on network failure and surfaces the error via onError', async () => {
		const harness = socketHarness();
		const fake = fetchHarness();
		const errors: Error[] = [];
		const syncing = createSyncingClient({
			url: 'ws://test/ws',
			createSocket: harness.factory,
			fetch: fake.fetch,
			onError: (error) => errors.push(error)
		});
		fake.rejectWith(new Error('network down'));

		await expect(syncing.transact([['add', 1, 'a', 'x']])).rejects.toThrow('network down');
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toBe('network down');
	});

	it('derives the HTTP base from the ws url (wss → https, no trailing slash)', async () => {
		const harness = socketHarness();
		const ws = createSyncingClient({
			url: 'ws://test/ws',
			createSocket: harness.factory,
			fetch: fetchHarness().fetch
		});
		expect(ws.httpBaseUrl).toBe('http://test');

		const secureFake = fetchHarness();
		const secure = createSyncingClient({
			url: 'wss://secure.example/ws',
			createSocket: harness.factory,
			fetch: secureFake.fetch
		});
		expect(secure.httpBaseUrl).toBe('https://secure.example');
		await secure.transact([['add', 1, 'a', 'x']]);
		expect(secureFake.calls[0]?.url).toBe('https://secure.example/transact');
	});

	it('applies the server broadcast to the mirror after a write-through', async () => {
		const harness = socketHarness();
		const fake = fetchHarness();
		const syncing = createSyncingClient({
			url: 'ws://test/ws',
			createSocket: harness.factory,
			fetch: fake.fetch
		});
		fake.respond(true, 200, {
			facts: [[1, 'user/name', 'Alice', 1, 'add']],
			transaction: [1, 1000, null]
		});

		const result = await syncing.transact([['add', 1, 'user/name', 'Alice']], { actor: 'me' });
		expect(result.facts[0]?.[2]).toBe('Alice');

		// The server's broadcast reaches the mirror through the sync path.
		syncing.start();
		const socket = harness.current();
		socket.open();
		socket.message(json(synced(syncing.id)));
		socket.message(
			json({
				type: 'sync-event',
				id: syncing.id,
				event: {
					type: 'transaction:committed',
					transaction: [1, 1000, null],
					facts: [[1, 'user/name', 'Alice', 1, 'add']]
				}
			})
		);
		expect(syncing.client.getFacts()).toContainEqual([1, 'user/name', 'Alice', 1, 'add']);
		syncing.stop();
	});
});


