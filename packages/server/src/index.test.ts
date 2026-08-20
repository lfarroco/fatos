/**
 * Server tests
 */

import { describe, it, expect } from 'vitest';
import WebSocket from 'ws';
import { get as httpGet } from 'node:http';
import { createFatosServer, version } from './index';
import type { StorageAdapter } from '@fatos/persistence';
import { MemoryAdapter } from '@fatos/persistence';
import { createDatabase, deserializeValue, isRef, ref, REF_BRAND, type Fact } from '@fatos/core';

/** Polls `messages` until `predicate` matches one of them or the timeout hits. */
function waitForMessage(
	messages: unknown[],
	predicate: (message: unknown) => boolean,
	timeoutMs = 2000
): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const check = () => {
			if (messages.some(predicate)) {
				resolve();
				return;
			}

			if (Date.now() - started > timeoutMs) {
				reject(new Error('Timed out waiting for websocket message'));
				return;
			}

			setTimeout(check, 10);
		};
		check();
	});
}

/** Like {@link waitForMessage} but only considers messages at index >= `fromIndex`. */
function waitForNewMessage(
	messages: unknown[],
	fromIndex: number,
	predicate: (message: unknown) => boolean,
	timeoutMs = 2000
): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const check = () => {
			for (let i = fromIndex; i < messages.length; i += 1) {
				if (predicate(messages[i])) {
					resolve();
					return;
				}
			}

			if (Date.now() - started > timeoutMs) {
				reject(new Error('Timed out waiting for websocket message'));
				return;
			}

			setTimeout(check, 10);
		};
		check();
	});
}

async function connectSocket(wsUrl: string): Promise<{ socket: WebSocket; messages: unknown[] }> {
	const socket = new WebSocket(wsUrl);
	await new Promise<void>((resolve, reject) => {
		socket.once('open', () => resolve());
		socket.once('error', reject);
	});

	const messages: unknown[] = [];
	socket.on('message', (message) => {
		messages.push(JSON.parse(message.toString()) as unknown);
	});

	return { socket, messages };
}

describe('@fatos/server', () => {
	it('should export version', () => {
		expect(version).toBeDefined();
	});

	it('exposes REST APIs for transact, facts, entity, and transactions', async () => {
		const server = createFatosServer();
		const { host, port } = await server.start({ port: 0 });
		const baseUrl = `http://${host}:${port}`;

		try {
			const transactResponse = await fetch(`${baseUrl}/transact`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					entries: [
						['add', 1, 'type', 'user'],
						['add', 1, 'name', 'Alice'],
						['add', 2, 'type', 'admin']
					],
					metadata: { source: 'http-test' }
				})
			});

			expect(transactResponse.status).toBe(200);
			const transactBody = (await transactResponse.json()) as {
				facts: unknown[];
				transaction: unknown;
			};
			expect(transactBody.facts).toHaveLength(3);
			expect(transactBody.transaction).toBeTruthy();

			const factsResponse = await fetch(`${baseUrl}/facts?attribute=type&value=user`);
			expect(factsResponse.status).toBe(200);
			const factsBody = (await factsResponse.json()) as { facts: unknown[] };
			expect(factsBody.facts).toEqual([[1, 'type', 'user', 1, 'add']]);

			const entityResponse = await fetch(`${baseUrl}/facts/1`);
			expect(entityResponse.status).toBe(200);
			const entityBody = (await entityResponse.json()) as { entity: unknown };
			expect(entityBody.entity).toEqual({ id: 1, type: 'user', name: 'Alice' });

			const transactionResponse = await fetch(`${baseUrl}/transactions`);
			expect(transactionResponse.status).toBe(200);
			const transactionBody = (await transactionResponse.json()) as { transactions: unknown[] };
			expect(transactionBody.transactions).toHaveLength(1);
		} finally {
			await server.stop();
		}
	});

	it('wire-tags Date/bigint/ref values on the REST entity + transactions endpoints (B4.3)', async () => {
		const server = createFatosServer();
		const { host, port } = await server.start({ port: 0 });
		const baseUrl = `http://${host}:${port}`;

		try {
			server.transact(
				[
					['add', 1, 'born', new Date(1_700_000_000_000)],
					['add', 1, 'count', 10n],
					['add', 1, 'friend', ref(2)]
				],
				{ when: new Date(1_600_000_000_000) }
			);

			const entityResponse = await fetch(`${baseUrl}/facts/1`);
			expect(entityResponse.status).toBe(200);
			const entityBody = (await entityResponse.json()) as { entity: Record<string, unknown> };
			expect(entityBody.entity).toEqual({
				id: 1,
				born: { $date: 1_700_000_000_000 },
				count: { $bigint: '10' },
				friend: { $ref: 2 }
			});

			const txResponse = await fetch(`${baseUrl}/transactions`);
			const txBody = (await txResponse.json()) as {
				transactions: [number, number, Record<string, unknown> | null][];
			};
			expect(txBody.transactions).toHaveLength(1);
			expect(txBody.transactions[0][2]).toEqual({ when: { $date: 1_600_000_000_000 } });
		} finally {
			await server.stop();
		}
	});

	it('supports tx-limited entity snapshots over HTTP', async () => {
		const server = createFatosServer();
		const { host, port } = await server.start({ port: 0 });
		const baseUrl = `http://${host}:${port}`;

		try {
			await fetch(`${baseUrl}/facts`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ op: 'add', eid: 7, attribute: 'name', value: 'Alice' })
			});
			await fetch(`${baseUrl}/facts`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ op: 'add', eid: 7, attribute: 'type', value: 'user' })
			});
			await fetch(`${baseUrl}/facts`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ op: 'retract', eid: 7, attribute: 'type', value: 'user' })
			});

			const at2 = await fetch(`${baseUrl}/facts/7?tx=2`);
			const at2Body = (await at2.json()) as { entity: unknown };
			expect(at2Body.entity).toEqual({ id: 7, name: 'Alice', type: 'user' });

			const at3 = await fetch(`${baseUrl}/facts/7?tx=3`);
			const at3Body = (await at3.json()) as { entity: unknown };
			expect(at3Body.entity).toEqual({ id: 7, name: 'Alice' });
		} finally {
			await server.stop();
		}
	});

	it('fans out commit events to multiple subscribers for real-time sync', () => {
		const server = createFatosServer();
		const eventsA: string[] = [];
		const eventsB: string[] = [];

		const unsubA = server.subscribe((event) => {
			eventsA.push(event.type);
		});
		const unsubB = server.subscribe((event) => {
			eventsB.push(event.type);
		});

		server.transact([
			['add', 11, 'type', 'user'],
			['retract', 11, 'type', 'user']
		]);

		unsubA();
		server.transact([['add', 12, 'type', 'user']]);
		unsubB();

		expect(eventsA).toEqual(['fact:added', 'fact:retracted', 'transaction:committed']);
		expect(eventsB).toEqual([
			'fact:added',
			'fact:retracted',
			'transaction:committed',
			'fact:added',
			'transaction:committed'
		]);
	});

	it('streams realtime events over WebSocket transport', async () => {
		const server = createFatosServer();
		const { host, port } = await server.start({ port: 0 });
		const httpBaseUrl = `http://${host}:${port}`;
		const wsUrl = `ws://${host}:${port}/ws`;

		const socket = new WebSocket(wsUrl);
		const receivedTypes: string[] = [];

		try {
			await new Promise<void>((resolve, reject) => {
				socket.once('open', () => resolve());
				socket.once('error', reject);
			});

			socket.on('message', (message) => {
				const payload = JSON.parse(message.toString()) as { type?: string };
				if (payload.type) {
					receivedTypes.push(payload.type);
				}
			});

			await fetch(`${httpBaseUrl}/facts`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ op: 'add', eid: 99, attribute: 'type', value: 'user' })
			});

			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error('Timed out waiting for websocket events')), 1000);
				const check = () => {
					if (receivedTypes.includes('fact:added') && receivedTypes.includes('transaction:committed')) {
						clearTimeout(timeout);
						resolve();
						return;
					}

					setTimeout(check, 10);
				};

				check();
			});

			expect(receivedTypes).toContain('fact:added');
			expect(receivedTypes).toContain('transaction:committed');
		} finally {
			socket.close();
			await server.stop();
		}
	});

	it('keeps the raw fan-out for bare clients and skips subscribed ones', async () => {
		const server = createFatosServer();
		const { host, port } = await server.start({ port: 0 });
		const wsUrl = `ws://${host}:${port}/ws`;

		const a = await connectSocket(wsUrl);
		const b = await connectSocket(wsUrl);
		const c = await connectSocket(wsUrl);
		const adminSpec = { find: ['?e'], where: [['?e', 'type', 'admin']] };
		const rawCommitted = (tx: number) => (message: unknown): boolean => {
			const msg = message as { type?: string; transaction?: [number] };
			return msg.type === 'transaction:committed' && msg.transaction?.[0] === tx;
		};
		const isRawEventType = (message: unknown): boolean => {
			const msg = message as { type?: string };
			return msg.type === 'fact:added' || msg.type === 'fact:retracted' || msg.type === 'transaction:committed';
		};

		try {
			// A subscribes (spec-filtered `facts` frames); C is a sync client
			// (`snapshot` + `sync-event` frames); B stays bare — the audit /
			// DevTools stream that receives the raw fan-out (design/03).
			a.socket.send(JSON.stringify({ type: 'subscribe', id: 'a-sub', spec: adminSpec }));
			await waitForMessage(a.messages, (message) => {
				const msg = message as { type?: string; id?: string };
				return msg.type === 'subscribed' && msg.id === 'a-sub';
			});
			c.socket.send(JSON.stringify({ type: 'sync', id: 'c-sync' }));
			await waitForMessage(c.messages, (message) => {
				const msg = message as { type?: string; id?: string };
				return msg.type === 'synced' && msg.id === 'c-sync';
			});

			server.transact([['add', 1, 'type', 'admin']]);

			// B (bare) receives the raw frame; A and C do NOT — they get their
			// own tailored frames and are excluded from the redundant raw
			// broadcast.
			await waitForMessage(b.messages, rawCommitted(1));
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(a.messages.filter(isRawEventType)).toEqual([]);
			expect(c.messages.filter(isRawEventType)).toEqual([]);

			// A still receives its spec-filtered facts frame; C its snapshot +
			// live sync-events.
			expect(
				a.messages.some((message) => {
					const msg = message as { type?: string; id?: string };
					return msg.type === 'facts' && msg.id === 'a-sub';
				})
			).toBe(true);
			expect(
				c.messages.some((message) => {
					const msg = message as { type?: string; id?: string };
					return msg.type === 'snapshot' && msg.id === 'c-sync';
				})
			).toBe(true);

			// After A unsubscribes its only subscription it becomes a bare
			// audit-stream client, so the next commit's raw frame reaches it.
			a.socket.send(JSON.stringify({ type: 'unsubscribe', id: 'a-sub' }));
			await new Promise((resolve) => setTimeout(resolve, 200));

			server.transact([['add', 2, 'type', 'admin']]);
			await waitForMessage(b.messages, rawCommitted(2));
			await waitForMessage(a.messages, rawCommitted(2));
		} finally {
			a.socket.close();
			b.socket.close();
			c.socket.close();
			await server.stop();
		}
	});

	it('POST /query returns datalog rows and honors the tx limit', async () => {
		const server = createFatosServer();
		const { host, port } = await server.start({ port: 0 });
		const baseUrl = `http://${host}:${port}`;

		try {
			await fetch(`${baseUrl}/transact`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					entries: [
						['add', 1, 'type', 'user'],
						['add', 1, 'name', 'Alice']
					]
				})
			});
			await fetch(`${baseUrl}/transact`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					entries: [
						['add', 2, 'type', 'user'],
						['add', 2, 'name', 'Bob']
					]
				})
			});
			await fetch(`${baseUrl}/transact`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					entries: [
						['add', 3, 'type', 'user'],
						['add', 3, 'name', 'Carol']
					]
				})
			});

			const spec = {
				find: ['?e', '?name'],
				where: [
					['?e', 'type', 'user'],
					['?e', 'name', '?name']
				]
			};

			const response = await fetch(`${baseUrl}/query`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ spec })
			});
			expect(response.status).toBe(200);
			const body = (await response.json()) as { rows: unknown[][] };
			expect(body.rows).toEqual([
				[1, 'Alice'],
				[2, 'Bob'],
				[3, 'Carol']
			]);

			const atTx1 = await fetch(`${baseUrl}/query`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ spec, tx: 1 })
			});
			const atTx1Body = (await atTx1.json()) as { rows: unknown[][] };
			expect(atTx1Body.rows).toEqual([[1, 'Alice']]);

			const bad = await fetch(`${baseUrl}/query`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ spec: { find: 'nope' } })
			});
			expect(bad.status).toBe(400);
		} finally {
			await server.stop();
		}
	});

	it('round-trips tagged Date/BigInt/ref values across REST', async () => {
		const server = createFatosServer();
		const { host, port } = await server.start({ port: 0 });
		const baseUrl = `http://${host}:${port}`;

		try {
			const transactResponse = await fetch(`${baseUrl}/transact`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					entries: [
						['add', 1, 'user/born', { $date: 1700000000000 }],
						['add', 1, 'user/serial', { $bigint: '9007199254740993' }],
						['add', 1, 'user/manager', { $ref: 42 }]
					]
				})
			});
			const transactBody = (await transactResponse.json()) as { facts: unknown[][] };
			expect(transactBody.facts).toEqual([
				[1, 'user/born', { $date: 1700000000000 }, 1, 'add'],
				[1, 'user/serial', { $bigint: '9007199254740993' }, 1, 'add'],
				[1, 'user/manager', { $ref: 42 }, 1, 'add']
			]);

			const factsResponse = await fetch(`${baseUrl}/facts`);
			const factsBody = (await factsResponse.json()) as { facts: unknown[][] };
			expect(factsBody.facts).toEqual(transactBody.facts);

			// The client-side reviver reconstructs the engine values.
			const born = deserializeValue(factsBody.facts[0][2]);
			expect(born).toBeInstanceOf(Date);
			expect((born as Date).getTime()).toBe(1700000000000);
			expect(deserializeValue(factsBody.facts[1][2])).toBe(9007199254740993n);

			const manager = deserializeValue(factsBody.facts[2][2]) as { [REF_BRAND]: unknown };
			expect(isRef(manager)).toBe(true);
			expect(manager[REF_BRAND]).toBe(42);
		} finally {
			await server.stop();
		}
	});

	it('tags transaction metadata in sync frames (catch-up and live)', async () => {
		const server = createFatosServer();
		const { host, port } = await server.start({ port: 0 });
		const wsUrl = `ws://${host}:${port}/ws`;

		// Seed the tagged transaction first, then pull it through the
		// afterTx catch-up path (afterTx: 0 keeps the chunked frames).
		server.transact([['add', 1, 'user/name', 'Alice']], { when: new Date(1_700_000_000_000), n: 10n });

		const { socket, messages } = await connectSocket(wsUrl);
		try {
			socket.send(JSON.stringify({ type: 'sync', id: 'tagged-sync', afterTx: 0 }));
			await waitForMessage(messages, (message) => {
				const msg = message as { type?: string; id?: string };
				return msg.type === 'synced' && msg.id === 'tagged-sync';
			});
			await waitForMessage(messages, (message) => {
				const msg = message as { type?: string; id?: string; transactions?: unknown[] };
				return msg.type === 'transactions' && msg.id === 'tagged-sync' && msg.transactions?.length === 1;
			});
			const txFrame = messages.find((message) => {
				const msg = message as { type?: string; id?: string };
				return msg.type === 'transactions' && msg.id === 'tagged-sync';
			}) as { transactions: [number, number, Record<string, unknown>][] };
			expect(txFrame.transactions[0]?.[2]).toEqual({
				when: { $date: 1_700_000_000_000 },
				n: { $bigint: '10' }
			});

			// A live sync-event's metadata is tagged as well.
			server.transact([['add', 2, 'user/name', 'Bob']], { source: 'live' });
			await waitForMessage(messages, (message) => {
				const msg = message as { type?: string; id?: string; event?: { transaction?: [number] } };
				return msg.type === 'sync-event' && msg.id === 'tagged-sync' && msg.event?.transaction?.[0] === 2;
			});
			const syncEvent = messages.find((message) => {
				const msg = message as { type?: string; id?: string };
				return msg.type === 'sync-event' && msg.id === 'tagged-sync';
			}) as { event: { transaction: [number, number, Record<string, unknown>]; facts: unknown[][] } };
			expect(syncEvent.event.transaction[2]).toEqual({ source: 'live' });
			expect(syncEvent.event.facts).toEqual([[2, 'user/name', 'Bob', 2, 'add']]);
		} finally {
			socket.close();
			await server.stop();
		}
	});

	it('sync with afterTime streams exactly the facts committed at/after that time', async () => {
		// Controlled timestamps via a storage adapter (commits stamp Date.now()).
		const storage = new MemoryAdapter();
		await storage.save({
			facts: [
				[1, 'user/name', 'Alice', 1, 'add'],
				[1, 'user/age', 20, 2, 'add'],
				[1, 'user/age', 21, 3, 'add']
			],
			transactions: [
				[1, 1_000, null],
				[2, 2_000, null],
				[3, 3_000, null]
			]
		});
		const server = createFatosServer({ storage });
		const { host, port } = await server.start({ port: 0 });
		const wsUrl = `ws://${host}:${port}/ws`;

		const { socket, messages } = await connectSocket(wsUrl);
		try {
			// afterTime 1500 → catch-up is txs 2,3 (committed at/after 1500).
			socket.send(JSON.stringify({ type: 'sync', id: 'time-sync', afterTime: 1_500 }));
			await waitForMessage(messages, (message) => {
				const msg = message as { type?: string; id?: string };
				return msg.type === 'synced' && msg.id === 'time-sync';
			});
			await waitForMessage(messages, (message) => {
				const msg = message as { type?: string; id?: string; transactions?: unknown[] };
				return msg.type === 'transactions' && msg.id === 'time-sync' && msg.transactions?.length === 2;
			});

			const factFrames = messages.filter((message) => {
				const msg = message as { type?: string; id?: string };
				return msg.type === 'facts' && msg.id === 'time-sync';
			}) as { facts: unknown[][] }[];
			expect(factFrames.flatMap((frame) => frame.facts)).toEqual([
				[1, 'user/age', 20, 2, 'add'],
				[1, 'user/age', 21, 3, 'add']
			]);

			const txFrame = messages.find((message) => {
				const msg = message as { type?: string; id?: string };
				return msg.type === 'transactions' && msg.id === 'time-sync';
			}) as { transactions: unknown[][] };
			expect(txFrame.transactions.map((tx) => tx[0])).toEqual([2, 3]);

			// Boundary: afterTime exactly at tx 2's timestamp includes tx 2.
			socket.send(JSON.stringify({ type: 'sync', id: 'time-boundary', afterTime: 2_000 }));
			await waitForMessage(messages, (message) => {
				const msg = message as { type?: string; id?: string; transactions?: unknown[] };
				return msg.type === 'transactions' && msg.id === 'time-boundary' && msg.transactions?.length === 2;
			});
			const boundaryFrames = messages.filter((message) => {
				const msg = message as { type?: string; id?: string };
				return msg.type === 'facts' && msg.id === 'time-boundary';
			}) as { facts: unknown[][] }[];
			expect(boundaryFrames.flatMap((frame) => frame.facts)).toEqual([
				[1, 'user/age', 20, 2, 'add'],
				[1, 'user/age', 21, 3, 'add']
			]);
		} finally {
			socket.close();
			await server.stop();
		}
	});

	it('GET /facts?since= streams facts committed at/after the timestamp', async () => {
		const storage = new MemoryAdapter();
		await storage.save({
			facts: [
				[1, 'user/name', 'Alice', 1, 'add'],
				[1, 'user/age', 20, 2, 'add'],
				[1, 'user/age', 21, 3, 'add']
			],
			transactions: [
				[1, 1_000, null],
				[2, 2_000, null],
				[3, 3_000, null]
			]
		});
		const server = createFatosServer({ storage });
		const { host, port } = await server.start({ port: 0 });
		const baseUrl = `http://${host}:${port}`;

		try {
			const sinceBody = (await (await fetch(`${baseUrl}/facts?since=1500`)).json()) as { facts: unknown[] };
			expect(sinceBody.facts).toEqual([
				[1, 'user/age', 20, 2, 'add'],
				[1, 'user/age', 21, 3, 'add']
			]);

			// Boundary: since exactly at tx 2's timestamp includes tx 2.
			const boundaryBody = (await (await fetch(`${baseUrl}/facts?since=2000`)).json()) as { facts: unknown[] };
			expect(boundaryBody.facts).toEqual([
				[1, 'user/age', 20, 2, 'add'],
				[1, 'user/age', 21, 3, 'add']
			]);

			// Before the first commit: the whole log.
			const allBody = (await (await fetch(`${baseUrl}/facts?since=0`)).json()) as { facts: unknown[] };
			expect(allBody.facts).toEqual([
				[1, 'user/name', 'Alice', 1, 'add'],
				[1, 'user/age', 20, 2, 'add'],
				[1, 'user/age', 21, 3, 'add']
			]);

			// After the last commit: nothing.
			const noneBody = (await (await fetch(`${baseUrl}/facts?since=3001`)).json()) as { facts: unknown[] };
			expect(noneBody.facts).toEqual([]);
		} finally {
			await server.stop();
		}
	});

	it('streams wire-tagged values over the SSE event stream', async () => {
		const server = createFatosServer();
		const { host, port } = await server.start({ port: 0 });

		let connectedResolve: (() => void) | undefined;
		const connected = new Promise<void>((resolve) => {
			connectedResolve = resolve;
		});
		let receivedResolve: ((body: string) => void) | undefined;
		const received = new Promise<string>((resolve) => {
			receivedResolve = resolve;
		});

		const request = httpGet({ host: '127.0.0.1', port, path: '/events' }, (response) => {
			response.setEncoding('utf8');
			let buffer = '';
			response.on('data', (chunk: string) => {
				buffer += chunk;
				if (buffer.includes('event: ready')) {
					// The SSE subscription is registered; commit now so the
					// streamed events are not missed.
					connectedResolve?.();
				}
				if (
					buffer.includes('event: transaction:committed')
					&& buffer.includes('$date')
					&& buffer.includes('$bigint')
					&& buffer.includes('$ref')
				) {
					receivedResolve?.(buffer);
				}
			});
		});
		request.on('error', () => {
			connectedResolve?.();
			receivedResolve?.('');
		});

		try {
			await connected;
			server.transact([
				['add', 1, 'user/born', new Date(1_700_000_000_000)],
				['add', 1, 'user/serial', 9_007_199_254_740_993n],
				['add', 1, 'user/manager', ref(2)]
			]);

			const body = await received;
			expect(body).toContain('event: fact:added');
			expect(body).toContain('event: transaction:committed');
			expect(body).toContain('"$date":1700000000000');
			expect(body).toContain('"$bigint":"9007199254740993"');
			expect(body).toContain('"$ref":2');
		} finally {
			request.destroy();
			await server.stop();
		}
	});

	it('serializes the raw WS fan-out with wire tags (Date/bigint/ref values and metadata)', async () => {
		const server = createFatosServer();
		const { host, port } = await server.start({ port: 0 });
		const wsUrl = `ws://${host}:${port}/ws`;

		const { socket, messages } = await connectSocket(wsUrl);

		try {
			server.transact(
				[
					['add', 1, 'user/born', new Date(1_700_000_000_000)],
					['add', 1, 'user/serial', 9_007_199_254_740_993n],
					['add', 1, 'user/manager', ref(2)]
				],
				{ when: new Date(1_700_000_000_000), n: 10n }
			);

			// A bare connection is the audit/DevTools stream: the raw
			// transaction:committed frame carries tagged facts and tagged
			// metadata — nothing throws, everything round-trips.
			await waitForMessage(messages, (message) => {
				const msg = message as { type?: string; transaction?: [number] };
				return msg.type === 'transaction:committed' && msg.transaction?.[0] === 1;
			});
			const committed = messages.find((message) => {
				const msg = message as { type?: string; transaction?: [number] };
				return msg.type === 'transaction:committed' && msg.transaction?.[0] === 1;
			}) as {
				transaction: [number, number, Record<string, unknown>];
				facts: unknown[][];
			};
			expect(committed.transaction[2]).toEqual({
				when: { $date: 1_700_000_000_000 },
				n: { $bigint: '10' }
			});
			expect(committed.facts.map((fact) => fact[2])).toEqual([
				{ $date: 1_700_000_000_000 },
				{ $bigint: '9007199254740993' },
				{ $ref: 2 }
			]);

			// Per-fact frames are tagged too.
			await waitForMessage(messages, (message) => {
				const msg = message as { type?: string; fact?: [unknown] };
				return msg.type === 'fact:added' && msg.fact?.[0] === 1;
			});
			const factFrames = messages.filter((message) => {
				const msg = message as { type?: string; fact?: [unknown] };
				return msg.type === 'fact:added' && msg.fact?.[0] === 1;
			}) as Array<{ fact: [unknown, unknown, unknown] }>;
			expect(factFrames.map((frame) => frame.fact[2])).toEqual([
				{ $date: 1_700_000_000_000 },
				{ $bigint: '9007199254740993' },
				{ $ref: 2 }
			]);
		} finally {
			socket.close();
			await server.stop();
		}
	});

	it('supports WS subscribe/unsubscribe with live facts pushes', async () => {
		const server = createFatosServer();
		const { host, port } = await server.start({ port: 0 });
		const wsUrl = `ws://${host}:${port}/ws`;

		const { socket, messages } = await connectSocket(wsUrl);
		const isAdminFacts = (message: unknown): boolean => {
			const msg = message as { type?: string; id?: string; rows?: unknown[][] };
			return msg.type === 'facts' && msg.id === 'admins';
		};

		try {
			socket.send(
				JSON.stringify({
					type: 'subscribe',
					id: 'admins',
					spec: {
						find: ['?e', '?name'],
						where: [
							['?e', 'type', 'admin'],
							['?e', 'name', '?name']
						]
					}
				})
			);

			await waitForMessage(messages, (message) => {
				const msg = message as { type?: string; id?: string };
				return msg.type === 'subscribed' && msg.id === 'admins';
			});

			server.transact([
				['add', 10, 'type', 'admin'],
				['add', 10, 'name', 'Ada']
			]);

			await waitForMessage(messages, (message) => {
				const msg = message as { rows?: unknown[][] };
				return isAdminFacts(message) && JSON.stringify(msg.rows) === JSON.stringify([[10, 'Ada']]);
			});
			expect(messages.filter(isAdminFacts)).toHaveLength(1);

			socket.send(JSON.stringify({ type: 'unsubscribe', id: 'admins' }));

			// WS messages from one client are processed in order, so the
			// 'subscribed' ack for a follow-up subscription proves the server has
			// processed the unsubscribe before we transact below.
			socket.send(
				JSON.stringify({
					type: 'subscribe',
					id: 'admins2',
					spec: {
						find: ['?e'],
						where: [['?e', 'type', 'admin']]
					}
				})
			);
			await waitForMessage(messages, (message) => {
				const msg = message as { type?: string; id?: string };
				return msg.type === 'subscribed' && msg.id === 'admins2';
			});

			// One transaction that would change the subscribed rows if the
			// registry still held the subscription.
			server.transact([
				['add', 11, 'type', 'admin'],
				['add', 11, 'name', 'Bob']
			]);

			// The live 'admins2' subscription matches the new admin — proving
			// the commit happened and the server still pushes for active
			// subscriptions ...
			await waitForMessage(messages, (message) => {
				const msg = message as { type?: string; id?: string; rows?: unknown[][] };
				return (
					msg.type === 'facts' &&
					msg.id === 'admins2' &&
					msg.rows?.some((row) => row[0] === 11) === true
				);
			});

			// ... but no 'facts' push for the unsubscribed id arrives.
			expect(messages.filter(isAdminFacts)).toHaveLength(1);
		} finally {
			socket.close();
			await server.stop();
		}
	});

	it('streams catch-up rows after subscribing with afterTx, then live updates', async () => {
		const server = createFatosServer();
		const { host, port } = await server.start({ port: 0 });
		const wsUrl = `ws://${host}:${port}/ws`;

		// Seed two transactions before the client connects.
		server.transact([
			['add', 1, 'type', 'admin'],
			['add', 1, 'name', 'Ada']
		]);
		server.transact([
			['add', 2, 'type', 'admin'],
			['add', 2, 'name', 'Bob']
		]);

		const { socket, messages } = await connectSocket(wsUrl);
		const spec = {
			find: ['?e', '?name'],
			where: [
				['?e', 'type', 'admin'],
				['?e', 'name', '?name']
			]
		};
		const rowsMatch = (message: unknown, expected: unknown[][]): boolean => {
			const msg = message as { type?: string; id?: string; rows?: unknown[][] };
			return (
				msg.type === 'facts' &&
				msg.id === 'admins' &&
				JSON.stringify(msg.rows) === JSON.stringify(expected)
			);
		};

		try {
			socket.send(JSON.stringify({ type: 'subscribe', id: 'admins', afterTx: 1, spec }));

			await waitForMessage(messages, (message) => {
				const msg = message as { type?: string; id?: string };
				return msg.type === 'subscribed' && msg.id === 'admins';
			});

			// Catch-up snapshot first, then live updates.
			await waitForMessage(messages, (message) => rowsMatch(message, [[1, 'Ada'], [2, 'Bob']]));

			server.transact([
				['add', 3, 'type', 'admin'],
				['add', 3, 'name', 'Carol']
			]);

			await waitForMessage(messages, (message) =>
				rowsMatch(message, [
					[1, 'Ada'],
					[2, 'Bob'],
					[3, 'Carol']
				])
			);

			// Re-subscribe with afterTx: a fresh catch-up snapshot is streamed.
			const beforeResubscribe = messages.length;
			socket.send(JSON.stringify({ type: 'subscribe', id: 'admins', afterTx: 2, spec }));

			await waitForNewMessage(messages, beforeResubscribe, (message) => {
				const msg = message as { type?: string; id?: string };
				return msg.type === 'subscribed' && msg.id === 'admins';
			});
			await waitForNewMessage(messages, beforeResubscribe, (message) =>
				rowsMatch(message, [[1, 'Ada'], [2, 'Bob'], [3, 'Carol']])
			);
			expect(
				messages.slice(beforeResubscribe).filter((message) => (message as { type?: string }).type === 'facts')
			).toHaveLength(1);
		} finally {
			socket.close();
			await server.stop();
		}
	});

	it('seeds from a storage adapter and persists every transaction across restarts', async () => {
		const storage = new MemoryAdapter();

		const first = createFatosServer({ storage });
		const firstAddress = await first.start({ port: 0 });
		try {
			first.transact(
				[
					['add', 1, 'type', 'user'],
					['add', 1, 'name', 'Alice']
				],
				{ source: 'persistence' }
			);
			await first.flush();
		} finally {
			await first.stop();
		}

		// A brand-new server seeded from the same adapter must see everything.
		const second = createFatosServer({ storage });
		const secondAddress = await second.start({ port: 0 });
		const baseUrl = `http://${secondAddress.host}:${secondAddress.port}`;
		try {
			const factsResponse = await fetch(`${baseUrl}/facts`);
			const factsBody = (await factsResponse.json()) as { facts: unknown[] };
			expect(factsBody.facts).toEqual([
				[1, 'type', 'user', 1, 'add'],
				[1, 'name', 'Alice', 1, 'add']
			]);

			const txResponse = await fetch(`${baseUrl}/transactions`);
			const txBody = (await txResponse.json()) as {
				transactions: [number, number, Record<string, unknown> | null][];
			};
			expect(txBody.transactions).toHaveLength(1);
			expect(txBody.transactions[0][0]).toBe(1);
			expect(txBody.transactions[0][1]).toEqual(expect.any(Number));
			expect(txBody.transactions[0][2]).toEqual({ source: 'persistence' });

			// Tx numbering stays consistent after restore: the next commit is tx 2.
			second.transact([['add', 2, 'type', 'admin']]);
			await second.flush();

			const factsAfter = (await (await fetch(`${baseUrl}/facts`)).json()) as { facts: unknown[] };
			expect(factsAfter.facts).toEqual([
				[1, 'type', 'user', 1, 'add'],
				[1, 'name', 'Alice', 1, 'add'],
				[2, 'type', 'admin', 2, 'add']
			]);
		} finally {
			await second.stop();
		}
	});

	it('surfaces storage save failures on flush()', async () => {
		const failing: StorageAdapter = {
			async load() {
				return { facts: [], transactions: [] };
			},
			async save() {
				throw new Error('disk full');
			},
			async close() {}
		};

		const server = createFatosServer({ storage: failing });
		await server.start({ port: 0 });
		try {
			server.transact([['add', 1, 'type', 'user']]);
			await expect(server.flush()).rejects.toThrow(/disk full/);
		} finally {
			await server.stop();
		}
	});

	it('persists via append() when the adapter supports it and checkpoints a snapshot on stop', async () => {
		const calls: Array<{ kind: 'append' | 'save'; tx: number; factCount: number }> = [];
		const storage: StorageAdapter = {
			async load() {
				return { facts: [], transactions: [] };
			},
			async save(snapshot) {
				calls.push({
					kind: 'save',
					tx: snapshot.transactions.at(-1)?.[0] ?? 0,
					factCount: snapshot.facts.length
				});
			},
			async append(transaction, facts) {
				calls.push({ kind: 'append', tx: transaction[0], factCount: facts.length });
			},
			async close() {}
		};

		const server = createFatosServer({ storage });
		await server.start({ port: 0 });
		try {
			server.transact([
				['add', 1, 'type', 'user'],
				['add', 1, 'name', 'Alice']
			]);
			await server.flush();

			// Steady-state writes go through the O(transaction) append path —
			// the full fact log is never re-serialized per commit.
			expect(calls).toEqual([{ kind: 'append', tx: 1, factCount: 2 }]);
		} finally {
			await server.stop();
		}

		// stop() compacts: the append log is merged into one full snapshot save.
		expect(calls).toEqual([
			{ kind: 'append', tx: 1, factCount: 2 },
			{ kind: 'save', tx: 1, factCount: 2 }
		]);
	});

	it('streams full fact logs with afterTx catch-up and live sync-events', async () => {
		const server = createFatosServer();
		const { host, port } = await server.start({ port: 0 });
		const wsUrl = `ws://${host}:${port}/ws`;

		// Seed: tx 1 = schema + data, tx 2 = a ref value (exercises wire tags).
		server.transact([
			{ ident: 'user/name', valueType: 'string', cardinality: 'one' },
			['add', 1, 'user/name', 'Alice'],
			['add', 1, 'user/age', 30]
		]);
		server.transact([['add', 1, 'user/manager', ref(2)]]);

		const { socket, messages } = await connectSocket(wsUrl);
		const withId = (type: string) => (message: unknown): boolean => {
			const msg = message as { type?: string; id?: string };
			return msg.type === type && msg.id === 'sync-1';
		};

		try {
			socket.send(JSON.stringify({ type: 'sync', id: 'sync-1', afterTx: 1 }));

			await waitForMessage(messages, withId('synced'));

			// Catch-up: only facts/transactions with tx > 1.
			await waitForMessage(messages, (message) => {
				const msg = message as { type?: string; facts?: unknown[] };
				return (
					msg.type === 'facts'
					&& msg.facts?.length === 1
					&& (msg.facts[0] as [unknown, unknown, unknown])[1] === 'user/manager'
				);
			});
			await waitForMessage(messages, (message) => {
				const msg = message as { type?: string; transactions?: unknown[] };
				return msg.type === 'transactions' && msg.transactions?.length === 1;
			});

			// Live sync-event for a commit that happens after the sync.
			server.transact([['add', 3, 'user/name', 'Bob']]);
			await waitForMessage(messages, (message) => {
				const msg = message as { type?: string; event?: { transaction?: [number] } };
				return msg.type === 'sync-event' && msg.event?.transaction?.[0] === 3;
			});

			// The ref value survived the wire (tagged $ref, deserializable).
			const factsFrame = messages.find(withId('facts')) as { facts: unknown[][] } | undefined;
			expect(factsFrame).toBeDefined();
			expect(isRef(deserializeValue(factsFrame?.facts[0]?.[2]))).toBe(true);
		} finally {
			socket.close();
			await server.stop();
		}
	});

	it('streams a compact state snapshot to a fresh sync, bounded by active state', async () => {
		const server = createFatosServer();
		const { host, port } = await server.start({ port: 0 });
		const wsUrl = `ws://${host}:${port}/ws`;
		const baseUrl = `http://${host}:${port}`;

		// History: one schema declaration (3 facts), then 100 churn
		// transactions leaving a single surviving name fact, then a tagged
		// value — 203 facts total, only 5 still asserted.
		server.transact([{ ident: 'user/name', valueType: 'string', cardinality: 'one' }]);
		server.transact([['add', 1, 'user/name', 'user-0']]);
		for (let i = 1; i < 100; i += 1) {
			server.transact([
				['retract', 1, 'user/name', `user-${i - 1}`],
				['add', 1, 'user/name', `user-${i}`]
			]);
		}
		server.transact([['add', 2, 'user/born', new Date(1_700_000_000_000)]]);

		const { socket, messages } = await connectSocket(wsUrl);
		try {
			socket.send(JSON.stringify({ type: 'sync', id: 'fresh' }));
			await waitForMessage(messages, (message) => {
				const msg = message as { type?: string; id?: string };
				return msg.type === 'snapshot' && msg.id === 'fresh';
			});

			const frame = messages.find((message) => {
				const msg = message as { type?: string; id?: string };
				return msg.type === 'snapshot' && msg.id === 'fresh';
			}) as { facts: unknown[][]; transactions: unknown[][] };

			// Bounded by active state: 5 current facts vs. the 203-fact log.
			expect(frame.facts).toHaveLength(5);
			expect(frame.transactions).toHaveLength(102);
			const allFacts = (await (await fetch(`${baseUrl}/facts`)).json()) as { facts: unknown[] };
			expect(allFacts.facts).toHaveLength(203);

			// The surviving name fact keeps its original tx; the value is wire-tagged.
			const nameFact = frame.facts.find((fact) => fact[1] === 'user/name');
			expect(nameFact).toEqual([1, 'user/name', 'user-99', 101, 'add']);
			const bornFact = frame.facts.find((fact) => fact[1] === 'user/born');
			expect(bornFact).toEqual([2, 'user/born', { $date: 1_700_000_000_000 }, 102, 'add']);

			// Applying the snapshot reproduces the server's current state and
			// the schema survives verbatim (the client's restore path).
			const db = createDatabase();
			const deserialized = frame.facts.map(
				(fact) => [fact[0], fact[1], deserializeValue(fact[2]), fact[3], fact[4]] as Fact
			);
			const factTxs = new Set(deserialized.map((fact) => fact[3]));
			const trimmed = frame.transactions.filter((transaction) =>
				factTxs.has(transaction[0] as number)
			) as Array<[number, number, Record<string, unknown> | null]>;
			db.restore({ facts: deserialized, transactions: trimmed });

			const entityBody = (await (await fetch(`${baseUrl}/facts/1`)).json()) as { entity: unknown };
			expect(db.entity(1)).toEqual(entityBody.entity);
			expect(db.entity(2)).toEqual({ id: 2, 'user/born': new Date(1_700_000_000_000) });
			expect(db.getSchemas().map((schema) => schema.ident)).toEqual(['user/name']);
			// The restored schema constraint is live.
			expect(() => db.transact([['add', 1, 'user/name', 'user-100']])).toThrow(/Cardinality conflict/);
		} finally {
			socket.close();
			await server.stop();
		}
	});

	it('streams full-log catch-up in bounded facts chunks', async () => {
		const server = createFatosServer();
		const { host, port } = await server.start({ port: 0 });
		const wsUrl = `ws://${host}:${port}/ws`;

		// One transaction with enough facts to span multiple chunks (2500 > 2000).
		const entries: Array<['add', number, string, number]> = [];
		for (let i = 0; i < 2500; i += 1) {
			entries.push(['add', i, 'n', i]);
		}
		server.transact(entries);

		const { socket, messages } = await connectSocket(wsUrl);
		try {
			// afterTx: 0 exercises the incremental catch-up path — fresh pulls
			// (no afterTx) now take the compact state snapshot instead, so the
			// chunked full-log framing is covered through the afterTx path.
			socket.send(JSON.stringify({ type: 'sync', id: 'sync-chunked', afterTx: 0 }));

			// The chunked catch-up is fully sent in one synchronous tick, so
			// waiting for the trailing 'transactions' frame is enough.
			await waitForMessage(messages, (message) => {
				const msg = message as { type?: string; id?: string };
				return msg.type === 'transactions' && msg.id === 'sync-chunked';
			});

			const factsFrames = messages.filter((message) => {
				const msg = message as { type?: string; id?: string; facts?: unknown[] };
				return msg.type === 'facts' && msg.id === 'sync-chunked' && Array.isArray(msg.facts);
			}) as Array<{ facts: unknown[][] }>;

			expect(factsFrames.length).toBeGreaterThan(1);
			const allFacts = factsFrames.flatMap((frame) => frame.facts);
			expect(allFacts).toHaveLength(2500);
			expect(allFacts[0]).toEqual([0, 'n', 0, 1, 'add']);
			expect(allFacts[2499]).toEqual([2499, 'n', 2499, 1, 'add']);
			// Chunks stay ordered by tx: concatenating them must be ascending.
			const txs = allFacts.map((fact) => (fact as [unknown, unknown, unknown, number])[3]);
			expect(txs).toEqual([...txs].sort((left, right) => left - right));
		} finally {
			socket.close();
			await server.stop();
		}
	});

	it('streams a state snapshot when afterTx is omitted and ignores unknown ids on unsubscribe', async () => {
		const server = createFatosServer();
		const { host, port } = await server.start({ port: 0 });
		const wsUrl = `ws://${host}:${port}/ws`;

		server.transact([['add', 1, 'type', 'user']]);

		const { socket, messages } = await connectSocket(wsUrl);
		try {
			socket.send(JSON.stringify({ type: 'sync', id: 'full' }));
			await waitForMessage(messages, (message) => {
				const msg = message as { type?: string; id?: string };
				return msg.type === 'synced' && msg.id === 'full';
			});
			// A fresh sync (no afterTx) receives the compact state snapshot.
			await waitForMessage(messages, (message) => {
				const msg = message as { type?: string; facts?: unknown[] };
				return msg.type === 'snapshot' && msg.facts?.length === 1;
			});

			// Unsubscribing a sync id stops live sync-events.
			socket.send(JSON.stringify({ type: 'unsubscribe', id: 'full' }));
			socket.send(JSON.stringify({ type: 'unsubscribe', id: 'never-existed' })); // no-op, no throw

			// WS messages from one client are processed in order, so the
			// 'synced' ack for a follow-up sync proves the server processed
			// the unsubscribes before we commit below.
			socket.send(JSON.stringify({ type: 'sync', id: 'probe' }));
			await waitForMessage(messages, (message) => {
				const msg = message as { type?: string; id?: string };
				return msg.type === 'synced' && msg.id === 'probe';
			});

			server.transact([['add', 2, 'type', 'admin']]);
			await waitForMessage(messages, (message) => {
				const msg = message as { type?: string; id?: string; event?: { transaction?: [number] } };
				return msg.type === 'sync-event' && msg.id === 'probe' && msg.event?.transaction?.[0] === 2;
			});

			// The unsubscribed id receives no further sync-events.
			const fullEvents = messages.filter(
				(message) => (message as { type?: string; id?: string }).type === 'sync-event'
					&& (message as { id?: string }).id === 'full'
			);
			expect(fullEvents).toHaveLength(0);
		} finally {
			socket.close();
			await server.stop();
		}
	});
});


describe('@fatos/server CORS', () => {
	it('defaults to same-origin: reflects a matching origin, blocks cross-origin', async () => {
		const server = createFatosServer();
		const { host, port } = await server.start({ port: 0 });
		const baseUrl = `http://${host}:${port}`;
		const selfOrigin = `http://${host}:${port}`;

		try {
			// Same-origin request: the Origin matches the request's Host.
			const sameOrigin = await fetch(`${baseUrl}/facts`, {
				headers: { origin: selfOrigin }
			});
			expect(sameOrigin.status).toBe(200);
			expect(sameOrigin.headers.get('access-control-allow-origin')).toBe(selfOrigin);

			// Cross-origin request (the demo client's separate port): no allow-origin.
			const crossOrigin = await fetch(`${baseUrl}/facts`, {
				headers: { origin: 'http://localhost:4176' }
			});
			expect(crossOrigin.headers.get('access-control-allow-origin')).toBeNull();

			// Cross-origin preflight is also refused (204 but no allow-origin).
			const preflight = await fetch(`${baseUrl}/transact`, {
				method: 'OPTIONS',
				headers: { origin: 'http://localhost:4176' }
			});
			expect(preflight.status).toBe(204);
			expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
			expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
		} finally {
			await server.stop();
		}
	});

	it('treats cors: true as the same-origin default', async () => {
		const server = createFatosServer({ cors: true });
		const { host, port } = await server.start({ port: 0 });
		const baseUrl = `http://${host}:${port}`;

		try {
			const response = await fetch(`${baseUrl}/facts`, {
				headers: { origin: 'http://localhost:4176' }
			});
			expect(response.headers.get('access-control-allow-origin')).toBeNull();
		} finally {
			await server.stop();
		}
	});

	it('answers cross-origin preflights and tags responses with origin: "*"', async () => {
		const server = createFatosServer({ cors: { origin: '*' } });
		const { host, port } = await server.start({ port: 0 });
		const baseUrl = `http://${host}:${port}`;

		try {
			const preflight = await fetch(`${baseUrl}/transact`, {
				method: 'OPTIONS',
				headers: { origin: 'http://localhost:4176' }
			});
			expect(preflight.status).toBe(204);
			expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
			expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
			expect(preflight.headers.get('access-control-allow-headers')).toContain('content-type');

			const post = await fetch(`${baseUrl}/transact`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: 'http://localhost:4176' },
				body: JSON.stringify({ entries: [['add', 1, 'type', 'user']] })
			});
			expect(post.status).toBe(200);
			expect(post.headers.get('access-control-allow-origin')).toBe('*');
		} finally {
			await server.stop();
		}
	});

	it('reflects only configured origins and omits the header for others', async () => {
		const server = createFatosServer({ cors: { origin: ['http://allowed.example'] } });
		const { host, port } = await server.start({ port: 0 });
		const baseUrl = `http://${host}:${port}`;

		try {
			const allowed = await fetch(`${baseUrl}/facts`, {
				headers: { origin: 'http://allowed.example' }
			});
			expect(allowed.status).toBe(200);
			expect(allowed.headers.get('access-control-allow-origin')).toBe('http://allowed.example');

			const blocked = await fetch(`${baseUrl}/facts`, {
				headers: { origin: 'http://evil.example' }
			});
			expect(blocked.headers.get('access-control-allow-origin')).toBeNull();
		} finally {
			await server.stop();
		}
	});

	it('omits CORS headers and preflight handling when disabled', async () => {
		const server = createFatosServer({ cors: false });
		const { host, port } = await server.start({ port: 0 });
		const baseUrl = `http://${host}:${port}`;

		try {
			const response = await fetch(`${baseUrl}/facts`, {
				headers: { origin: 'http://localhost:4176' }
			});
			expect(response.status).toBe(200);
			expect(response.headers.get('access-control-allow-origin')).toBeNull();

			const preflight = await fetch(`${baseUrl}/transact`, { method: 'OPTIONS' });
			expect(preflight.status).toBe(404);
		} finally {
			await server.stop();
		}
	});
});

describe('server authoring surface (insert/upsert/set/merge)', () => {
	it('insert commits object maps through the event path and returns aligned ids', () => {
		const server = createFatosServer();
		const events: string[] = [];
		const unsubscribe = server.subscribe((event) => events.push(event.type));

		const ids = server.insert(
			[
				{ id: 'eid1', name: 'weee' },
				{ id: 'eid2', name: 'Bob' }
			],
			{ source: 'seed' }
		);
		expect(ids).toEqual(['eid1', 'eid2']);
		expect(
			server.query({
				find: ['?e', '?name'],
				where: [['?e', 'name', '?name']]
			})
		).toEqual([
			['eid1', 'weee'],
			['eid2', 'Bob']
		]);
		// one commit → one transaction event, two fact events
		expect(events.filter((type) => type === 'transaction:committed')).toHaveLength(1);
		expect(events.filter((type) => type === 'fact:added')).toHaveLength(2);
		unsubscribe();
	});

	it('merge reconciles an existing entity; mergeEntity handles numeric ids', () => {
		const server = createFatosServer();
		server.insert({ id: 'eid1', name: 'weee', age: 33 });
		expect(server.merge({ eid1: { name: 'wow' } })).toEqual(['eid1']);
		expect(
			server.query({
				find: ['?e', '?name', '?age'],
				where: [
					['?e', 'name', '?name'],
					['?e', 'age', '?age']
				]
			})
		).toEqual([['eid1', 'wow', 33]]);

		expect(server.mergeEntity(7, { name: 'seven' })).toBe(7);
		expect(server.query({ find: ['?e'], where: [['?e', 'name', 'seven']] })).toEqual([[7]]);
	});

	it('set emits retract+add pairs through the event path', () => {
		const server = createFatosServer();
		const events: string[] = [];
		const unsubscribe = server.subscribe((event) => events.push(event.type));
		server.insert({ id: 'eid1', name: 'weee' });
		events.length = 0;

		server.set('eid1', { name: 'wow' });
		expect(events).toEqual(['fact:retracted', 'fact:added', 'transaction:committed']);
		unsubscribe();
	});

	it('persists object-map writes through the storage adapter', async () => {
		const storage = new MemoryAdapter();
		const server = createFatosServer({ storage });
		await server.start({ port: 0 });
		try {
			server.insert({ id: 'eid1', name: 'weee' });
			await server.flush();
			const snapshot = await storage.load();
			expect(snapshot.facts).toContainEqual(['eid1', 'name', 'weee', 1, 'add']);
		} finally {
			await server.stop();
		}
	});
});

