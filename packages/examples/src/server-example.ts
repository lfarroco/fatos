/**
 * Server — HTTP API and real-time WebSocket broadcast.
 *
 * Starts a real FatosServer on an ephemeral port, seeds it over REST, connects
 * a WebSocket client, writes from a second client, and watches the events
 * stream in real time.
 */
import { createFatosServer } from '@fatos/server';
import type { ServerEvent } from '@fatos/server';
import WebSocket from 'ws';
import { log, section, waitFor } from './helpers';

export type ServerExampleResult = {
	baseUrl: string;
	health: { status: string };
	seedFacts: unknown[];
	entity: unknown;
	facts: unknown[];
	transactions: unknown[];
	subscribedEvents: ServerEvent[];
	websocketEventTypes: string[];
};

async function getJson(url: string): Promise<Record<string, unknown>> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`GET ${url} failed with ${response.status}`);
	}

	return (await response.json()) as Record<string, unknown>;
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	if (!response.ok) {
		throw new Error(`POST ${url} failed with ${response.status}`);
	}

	return (await response.json()) as Record<string, unknown>;
}

export async function run(): Promise<ServerExampleResult> {
	section('Server — REST API and real-time WebSocket broadcast');

	const server = createFatosServer();
	const { host, port } = await server.start({ port: 0 });
	const baseUrl = `http://${host}:${port}`;
	const wsUrl = `ws://${host}:${port}/ws`;

	const subscribedEvents: ServerEvent[] = [];
	server.subscribe((event) => {
		subscribedEvents.push(event);
	});

	try {
		const health = (await getJson(`${baseUrl}/health`)) as { status: string };
		log('server', `Listening on ${baseUrl} — health: ${health.status}`);

		log('rest', 'Seed a schema and two items over POST /transact');
		const seed = await postJson(`${baseUrl}/transact`, {
			entries: [
				{ ident: 'item/name', valueType: 'string', cardinality: 'one' },
				['add', 1, 'item/name', 'coffee'],
				['add', 2, 'item/name', 'tea']
			],
			metadata: { source: 'seed' }
		});

		log('websocket', `Connecting a WebSocket client to ${wsUrl}`);
		const socket = new WebSocket(wsUrl);
		const websocketEventTypes: string[] = [];
		await new Promise<void>((resolve, reject) => {
			socket.once('open', () => resolve());
			socket.once('error', reject);
		});
		socket.on('message', (message) => {
			const payload = JSON.parse(String(message)) as ServerEvent;
			websocketEventTypes.push(payload.type);
		});

		log('rest', 'A second client writes a fact over POST /facts');
		await postJson(`${baseUrl}/facts`, {
			op: 'add',
			eid: 1,
			attribute: 'item/stock',
			value: 12
		});

		await waitFor(() => websocketEventTypes.length >= 2);
		log('websocket', `WebSocket client received: ${JSON.stringify(websocketEventTypes)}`);

		const facts = (await getJson(`${baseUrl}/facts`)) as { facts: unknown[] };
		const entity = (await getJson(`${baseUrl}/facts/1`)) as { entity: unknown };
		const transactions = (await getJson(`${baseUrl}/transactions`)) as { transactions: unknown[] };
		log('rest', `Entity 1: ${JSON.stringify(entity.entity)}`);
		log('rest', `Fact log has ${facts.facts.length} facts, transaction log has ${transactions.transactions.length} entries`);

		socket.close();

		return {
			baseUrl,
			health,
			seedFacts: seed.facts as unknown[],
			entity: entity.entity,
			facts: facts.facts,
			transactions: transactions.transactions,
			subscribedEvents,
			websocketEventTypes
		};
	} finally {
		await server.stop();
	}
}

