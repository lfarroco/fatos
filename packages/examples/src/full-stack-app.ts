/**
 * Full-stack app — two clients sharing one server.
 *
 * A "warehouse" WebSocket client watches live inventory events while a
 * "storefront" writes through the REST API. Also shows time-travel reads
 * over HTTP using transaction ids.
 */
import { createFatosServer } from '@fatos/server';
import type { ServerEvent } from '@fatos/server';
import WebSocket from 'ws';
import { log, section, waitFor } from './helpers';

export type FullStackResult = {
	baseUrl: string;
	storefrontEvents: ServerEvent[];
	warehouseEventTypes: string[];
	inventoryBeforeSale: Record<string, unknown> | null;
	inventoryNow: Record<string, unknown> | null;
	milk: Record<string, unknown> | null;
	transactionCount: number;
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

export async function run(): Promise<FullStackResult> {
	section('Full-stack app — REST writes, live WebSocket sync, time travel');

	const server = createFatosServer();
	const { host, port } = await server.start({ port: 0 });
	const baseUrl = `http://${host}:${port}`;
	const wsUrl = `ws://${host}:${port}/ws`;

	const storefrontEvents: ServerEvent[] = [];
	server.subscribe((event) => {
		storefrontEvents.push(event);
	});

	try {
		log('seed', 'The warehouse publishes the catalog (schema + items in one transaction)');
		await postJson(`${baseUrl}/transact`, {
			entries: [
				{ ident: 'item/name', valueType: 'string', cardinality: 'one' },
				{ ident: 'item/stock', valueType: 'number', cardinality: 'one' },
				['add', 1, 'item/name', 'coffee'],
				['add', 1, 'item/stock', 12],
				['add', 2, 'item/name', 'tea'],
				['add', 2, 'item/stock', 5]
			],
			metadata: { source: 'warehouse' }
		});

		log('sync', 'The storefront connects over WebSocket and waits for live events');
		const socket = new WebSocket(wsUrl);
		const warehouseEventTypes: string[] = [];
		await new Promise<void>((resolve, reject) => {
			socket.once('open', () => resolve());
			socket.once('error', reject);
		});
		socket.on('message', (message) => {
			const payload = JSON.parse(String(message)) as ServerEvent;
			warehouseEventTypes.push(payload.type);
		});

		log('write', 'The storefront records a sale: coffee stock 12 -> 11');
		log('write', '  A retraction removes the old value (own transaction)…');
		await postJson(`${baseUrl}/transact`, {
			entries: [['retract', 1, 'item/stock', 12]],
			metadata: { source: 'storefront', saleId: 'sale-0001' }
		});
		log('write', '  …then an add stores the new value (own transaction)');
		await postJson(`${baseUrl}/transact`, {
			entries: [['add', 1, 'item/stock', 11]],
			metadata: { source: 'storefront', saleId: 'sale-0001' }
		});

		// The warehouse client sees the change in real time.
		await waitFor(() => warehouseEventTypes.includes('fact:retracted'));
		log('sync', `Warehouse client received: ${JSON.stringify(warehouseEventTypes)}`);

		log('write', 'The storefront adds a new product (milk, stock 24)');
		await postJson(`${baseUrl}/transact`, {
			entries: [
				['add', 3, 'item/name', 'milk'],
				['add', 3, 'item/stock', 24]
			],
			metadata: { source: 'storefront' }
		});

		await waitFor(() => warehouseEventTypes.length >= 5);

		// Time travel: inventory before the sale vs. now.
		const before = (await getJson(`${baseUrl}/facts/1?tx=1`)) as { entity: Record<string, unknown> | null };
		const now = (await getJson(`${baseUrl}/facts/1`)) as { entity: Record<string, unknown> | null };
		const milk = (await getJson(`${baseUrl}/facts/3`)) as { entity: Record<string, unknown> | null };
		log('time-travel', `Coffee stock at tx 1 (before the sale): ${JSON.stringify(before.entity)}`);
		log('time-travel', `Coffee stock now: ${JSON.stringify(now.entity)}`);
		log('time-travel', `Milk: ${JSON.stringify(milk.entity)}`);

		const transactions = (await getJson(`${baseUrl}/transactions`)) as { transactions: unknown[] };
		log('audit', `Server transaction log: ${transactions.transactions.length} transactions`);

		socket.close();

		return {
			baseUrl,
			storefrontEvents,
			warehouseEventTypes,
			inventoryBeforeSale: before.entity,
			inventoryNow: now.entity,
			milk: milk.entity,
			transactionCount: transactions.transactions.length
		};
	} finally {
		await server.stop();
	}
}
