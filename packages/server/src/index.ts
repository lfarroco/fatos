/**
 * @fatos/server - Node.js server
 * 
 * This module provides the server-side implementation for Fatos.
 * It includes:
 * - Persistent fact store
 * - HTTP API (REST endpoints)
 * - WebSocket API (real-time synchronization)
 * - Multi-client coordination
 * - Transaction logging
 */

import { createServer, type IncomingMessage, type Server as NodeServer, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
	createDatabase,
	type Fact,
	type Mutation,
	type QuerySpec,
	type QueryTerm,
	type TransactionEntry,
	type TransactionRecord
} from '../../core/src/index';

export const version = '0.0.1';

export type Unsubscribe = () => void;

export type ServerEvent =
	| {
		type: 'fact:added' | 'fact:retracted';
		fact: Fact;
	}
	| {
		type: 'transaction:committed';
		transaction: TransactionRecord;
		facts: Fact[];
	};

export type StartOptions = {
	port?: number;
	host?: string;
};

export type ServerAddress = {
	port: number;
	host: string;
};

type JsonObject = Record<string, unknown>;

function parseQueryValue(raw: string): unknown {
	if (raw === 'null') {
		return null;
	}

	if (raw === 'true') {
		return true;
	}

	if (raw === 'false') {
		return false;
	}

	const asNumber = Number(raw);
	if (!Number.isNaN(asNumber) && raw.trim() !== '') {
		return asNumber;
	}

	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		if (typeof chunk === 'string') {
			chunks.push(Buffer.from(chunk));
			continue;
		}

		chunks.push(chunk);
	}

	if (chunks.length === 0) {
		return {};
	}

	const raw = Buffer.concat(chunks).toString('utf8');
	if (raw.trim() === '') {
		return {};
	}

	return JSON.parse(raw) as unknown;
}

function writeJson(res: ServerResponse, statusCode: number, payload: JsonObject): void {
	res.statusCode = statusCode;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.end(JSON.stringify(payload));
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class FatosServer {
	private db = createDatabase();
	private server: NodeServer | null = null;
	private listeners = new Set<(event: ServerEvent) => void>();
	private websocketServer: WebSocketServer | null = null;
	private websocketEventUnsubscribe: Unsubscribe | null = null;

	start(options: StartOptions = {}): Promise<ServerAddress> {
		if (this.server) {
			return Promise.resolve(this.getAddress());
		}

		const host = options.host ?? '127.0.0.1';
		const port = options.port ?? 0;

		this.server = createServer((req, res) => {
			void this.handleRequest(req, res);
		});

		this.websocketServer = new WebSocketServer({ noServer: true });
		this.server.on('upgrade', (req, socket, head) => {
			if (!this.websocketServer) {
				socket.destroy();
				return;
			}

			const requestUrl = new URL(req.url ?? '/', 'http://localhost');
			if (requestUrl.pathname !== '/ws') {
				socket.destroy();
				return;
			}

			this.websocketServer.handleUpgrade(req, socket, head, (client) => {
				this.websocketServer?.emit('connection', client, req);
			});
		});

		this.websocketEventUnsubscribe = this.subscribe((event) => {
			this.broadcastWebSocketEvent(event);
		});

		return new Promise((resolve, reject) => {
			this.server?.once('error', reject);
			this.server?.listen(port, host, () => {
				this.server?.off('error', reject);
				resolve(this.getAddress());
			});
		});
	}

	stop(): Promise<void> {
		if (this.websocketEventUnsubscribe) {
			this.websocketEventUnsubscribe();
			this.websocketEventUnsubscribe = null;
		}

		if (this.websocketServer) {
			for (const client of this.websocketServer.clients) {
				client.close();
			}
			this.websocketServer.close();
			this.websocketServer = null;
		}

		if (!this.server) {
			return Promise.resolve();
		}

		const toClose = this.server;
		this.server = null;
		return new Promise((resolve, reject) => {
			toClose.close((error) => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}

	getAddress(): ServerAddress {
		if (!this.server) {
			throw new Error('Server is not started');
		}

		const address = this.server.address();
		if (!address || typeof address === 'string') {
			throw new Error('Could not determine server address');
		}

		return {
			port: address.port,
			host: address.address
		};
	}

	subscribe(listener: (event: ServerEvent) => void): Unsubscribe {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private emit(event: ServerEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}

	private sendWebSocketEvent(client: WebSocket, event: ServerEvent): void {
		if (client.readyState !== 1) {
			return;
		}

		client.send(JSON.stringify(event));
	}

	private broadcastWebSocketEvent(event: ServerEvent): void {
		if (!this.websocketServer) {
			return;
		}

		for (const client of this.websocketServer.clients) {
			this.sendWebSocketEvent(client, event);
		}
	}

	transact(entries: TransactionEntry[], metadata?: Record<string, unknown>): Fact[] {
		const facts = this.db.transact(entries, metadata);
		if (facts.length === 0) {
			return facts;
		}

		for (const fact of facts) {
			const eventType = fact[4] === 'add' ? 'fact:added' : 'fact:retracted';
			this.emit({ type: eventType, fact });
		}

		const transaction = this.db.getTransactions().at(-1);
		if (transaction) {
			this.emit({
				type: 'transaction:committed',
				transaction,
				facts
			});
		}

		return facts;
	}

	private filteredFacts(searchParams: URLSearchParams): readonly Fact[] {
		const txRaw = searchParams.get('tx');
		const eidRaw = searchParams.get('eid');
		const attribute = searchParams.get('attribute');
		const valueRaw = searchParams.get('value');

		let facts = this.db.getFacts();

		if (txRaw !== null) {
			const tx = Number(txRaw);
			if (!Number.isFinite(tx)) {
				throw new Error('Invalid tx query value');
			}
			facts = facts.filter((fact) => fact[3] <= tx);
		}

		if (eidRaw !== null) {
			const eid = Number(eidRaw);
			if (!Number.isFinite(eid)) {
				throw new Error('Invalid eid query value');
			}
			facts = facts.filter((fact) => fact[0] === eid);
		}

		if (attribute !== null) {
			facts = facts.filter((fact) => fact[1] === attribute);
		}

		if (valueRaw !== null) {
			const value = parseQueryValue(valueRaw);
			facts = facts.filter((fact) => Object.is(fact[2], value));
		}

		return facts;
	}

	private handleSse(req: IncomingMessage, res: ServerResponse): void {
		res.statusCode = 200;
		res.setHeader('content-type', 'text/event-stream; charset=utf-8');
		res.setHeader('cache-control', 'no-cache');
		res.setHeader('connection', 'keep-alive');
		res.write('event: ready\n');
		res.write('data: {}\n\n');

		const unsubscribe = this.subscribe((event) => {
			res.write(`event: ${event.type}\n`);
			res.write(`data: ${JSON.stringify(event)}\n\n`);
		});

		req.on('close', () => {
			unsubscribe();
			res.end();
		});
	}

	private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			const method = req.method ?? 'GET';
			const requestUrl = new URL(req.url ?? '/', 'http://localhost');
			const pathname = requestUrl.pathname;

			if (method === 'GET' && pathname === '/health') {
				writeJson(res, 200, { status: 'ok' });
				return;
			}

			if (method === 'GET' && pathname === '/events') {
				this.handleSse(req, res);
				return;
			}

			if (method === 'GET' && pathname === '/facts') {
				const facts = this.filteredFacts(requestUrl.searchParams);
				writeJson(res, 200, { facts });
				return;
			}

			if (method === 'GET' && pathname.startsWith('/facts/')) {
				const eid = Number(pathname.slice('/facts/'.length));
				if (!Number.isFinite(eid)) {
					writeJson(res, 400, { error: 'Invalid entity id' });
					return;
				}

				const txRaw = requestUrl.searchParams.get('tx');
				const tx = txRaw === null ? undefined : Number(txRaw);
				if (txRaw !== null && !Number.isFinite(tx)) {
					writeJson(res, 400, { error: 'Invalid tx query value' });
					return;
				}

				const entity = this.db.entity(eid, tx);
				writeJson(res, 200, { entity });
				return;
			}

			if (method === 'GET' && pathname === '/transactions') {
				writeJson(res, 200, {
					transactions: this.db.getTransactions()
				});
				return;
			}

			if (method === 'POST' && pathname === '/transact') {
				const body = await readJsonBody(req);
				if (!isObject(body) || !Array.isArray(body.entries)) {
					writeJson(res, 400, { error: 'Request body must include entries array' });
					return;
				}

				const metadata = isObject(body.metadata)
					? (body.metadata as Record<string, unknown>)
					: undefined;
				const facts = this.transact(body.entries as TransactionEntry[], metadata);
				writeJson(res, 200, {
					facts,
					transaction: this.db.getTransactions().at(-1) ?? null
				});
				return;
			}

			if (method === 'POST' && pathname === '/facts') {
				const body = await readJsonBody(req);
				if (!isObject(body)) {
					writeJson(res, 400, { error: 'Invalid request body' });
					return;
				}

				const metadata = isObject(body.metadata)
					? (body.metadata as Record<string, unknown>)
					: undefined;

				let entries: TransactionEntry[] = [];
				if (Array.isArray(body.facts)) {
					entries = body.facts as Mutation[];
				} else {
					const op = body.op;
					const eid = body.eid;
					const attribute = body.attribute;
					if ((op !== 'add' && op !== 'retract') || typeof eid !== 'number' || typeof attribute !== 'string') {
						writeJson(res, 400, { error: 'Body must include facts array or op/eid/attribute/value' });
						return;
					}

					entries = [[op, eid, attribute, body.value]];
				}

				const facts = this.transact(entries, metadata);
				writeJson(res, 200, {
					facts,
					transaction: this.db.getTransactions().at(-1) ?? null
				});
				return;
			}

			writeJson(res, 404, { error: 'Not found' });
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown server error';
			writeJson(res, 500, { error: message });
		}
	}

	query(spec: QuerySpec, tx?: number): QueryTerm[][] {
		return this.db.query(spec, tx);
	}
}

export function createFatosServer(): FatosServer {
	return new FatosServer();
}
