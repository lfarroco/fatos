/**
 * Sync module tests: pure message/log pieces plus the syncing client driven
 * by an injected fake WebSocket (no real socket anywhere).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '@fatos/core';
import type { Fact, SyncServerMessage, SyncStatus, SyncTransactionEvent } from './index';
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


