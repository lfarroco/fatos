/**
 * Server tests
 */

import { describe, it, expect } from 'vitest';
import WebSocket from 'ws';
import { createFatosServer, version } from './index';

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
});
