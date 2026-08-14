/**
 * Server tests
 */

import { describe, it, expect } from 'vitest';
import WebSocket from 'ws';
import { createFatosServer, version } from './index';
import { deserializeValue, isRef, REF_BRAND } from '@fatos/core';

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

			// The raw fan-out still delivers the facts for eid 11 ...
			await waitForMessage(messages, (message) => {
				const msg = message as { type?: string; fact?: [unknown, unknown, unknown] };
				return msg.type === 'fact:added' && msg.fact?.[0] === 11;
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
});

