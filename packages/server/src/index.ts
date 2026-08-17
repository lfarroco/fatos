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
import type { StorageAdapter } from '@fatos/persistence';
import {
	createDatabase,
	deserializeQuerySpec,
	deserializeValue,
	serializeValue,
	type Fact,
	type LiveResult,
	type Mutation,
	type QuerySpec,
	type QueryTerm,
	type TransactionEntry,
	type TransactionRecord
} from '@fatos/core';

export const version = '0.0.1';

/**
 * Catch-up facts per `facts` frame when streaming a `sync` full-log pull
 * (design/03 + sync protocol). Bounding frame size keeps a huge full-log
 * catch-up from materializing one oversized WebSocket frame per connection.
 */
const SYNC_CATCH_UP_CHUNK = 2000;

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

/** CORS configuration for the HTTP API. */
export type CorsOptions = {
	/**
	 * Allowed origins:
	 * - `'same-origin'` (the default) reflects the `Origin` header only when it
	 *   matches the server's own host — cross-origin browsers are blocked, so
	 *   the API is only reachable from pages the server itself serves;
	 * - `'*'` answers any origin (browsers then never send credentials);
	 * - any other string or array of strings restricts
	 *   `access-control-allow-origin` to matching `Origin` headers.
	 */
	origin?: string | readonly string[];
	/** Preflight methods (default `['GET', 'POST', 'OPTIONS']`). */
	methods?: readonly string[];
	/** Preflight request headers (default `['content-type']`). */
	headers?: readonly string[];
};

/** Normalized internal CORS config. */
type NormalizedCors = {
	origin: '*' | 'same-origin' | string[];
	methods: readonly string[];
	headers: readonly string[];
};

/**
 * Construction options for {@link FatosServer}. When `storage` is provided the
 * server seeds its database from the adapter on `start()` and persists the
 * snapshot after every successful transaction; without it the server keeps its
 * existing in-memory-only behavior.
 */
export type FatosServerOptions = {
	storage?: StorageAdapter;
	/**
	 * Cross-origin access to the HTTP API. Defaults to `'same-origin'` — only
	 * requests whose `Origin` matches the server's own host are allowed, which
	 * is what a same-server-served app needs and nothing more. Pass
	 * `{ origin: '*' }` to open the API to any origin (the demo apps do this —
	 * their browser clients run on a separate port), an `origin` list to
	 * restrict, or `false` to disable CORS entirely.
	 */
	cors?: boolean | CorsOptions;
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
	for await (const chunk of req as AsyncIterable<Buffer | string>) {
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

/** Normalizes the `cors` option into the internal shape the request path reads. */
function normalizeCors(cors: boolean | CorsOptions | undefined): NormalizedCors | null {
	if (cors === false) {
		return null;
	}

	const origin =
		cors === true || cors === undefined || cors.origin === undefined ? 'same-origin' : cors.origin;
	return {
		origin:
			origin === '*' || origin === 'same-origin' ? origin : typeof origin === 'string' ? [origin] : [...origin],
		methods: cors === true || cors === undefined || cors.methods === undefined ? ['GET', 'POST', 'OPTIONS'] : cors.methods,
		headers: cors === true || cors === undefined || cors.headers === undefined ? ['content-type'] : cors.headers
	};
}

/**
 * The server's own origin as a browser would derive it for a same-origin
 * request: `scheme://` + the request's `Host` header (so `localhost:4200`,
 * `127.0.0.1:4200`, or a reverse-proxied hostname all work).
 */
function sameOriginOf(req: IncomingMessage): string | null {
	const host = req.headers.host;
	if (typeof host !== 'string' || host === '') {
		return null;
	}
	const encrypted = (req.socket as { encrypted?: boolean }).encrypted === true;
	return `${encrypted ? 'https' : 'http'}://${host}`;
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One client subscription in the WS subscribe registry (design/03): a
 * server-side mirror of `db.live(spec)` semantics, keyed by the client-chosen
 * subscription id.
 */
type ClientSubscription = {
	id: string;
	live: LiveResult<QueryTerm[][]>;
};

/** Serializes a fact for the wire: the 5-tuple shape is kept, values tagged (design/03). */
function serializeFact(fact: Fact): unknown {
	return [fact[0], fact[1], serializeValue(fact[2]), fact[3], fact[4]];
}

function serializeFacts(facts: readonly Fact[]): unknown[] {
	return facts.map(serializeFact);
}

function serializeRows(rows: readonly (readonly QueryTerm[])[]): unknown[][] {
	return rows.map((row) => row.map((term) => serializeValue(term)));
}

/** Wire-tags a transaction record's metadata values (design/03 $date/$bigint/$ref). */
function serializeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(metadata)) {
		result[key] = serializeValue(value);
	}
	return result;
}

/**
 * Serializes a transaction record for the wire. `TransactionRecord[2]` is
 * caller-supplied metadata (`Record<string, unknown>`) and can hold Date /
 * bigint / ref() values — JSON.stringify of the raw record would throw on a
 * bigint and silently corrupt refs to `{}` (B4.3).
 */
function serializeTransactionRecord(transaction: TransactionRecord): unknown {
	const metadata = transaction[2];
	return [transaction[0], transaction[1], metadata === null ? null : serializeMetadata(metadata)];
}

function serializeTransactions(transactions: readonly TransactionRecord[]): unknown[] {
	return transactions.map(serializeTransactionRecord);
}

/** Wire-tags an entity state's attribute values (design/03); `null` passes through. */
function serializeEntityState(entity: Record<string, unknown> | null): unknown {
	if (entity === null) {
		return null;
	}

	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(entity)) {
		result[key] = serializeValue(value);
	}
	return result;
}

/**
 * Derives the minimal fact set that reproduces the database's current entity
 * state (B4.1): for each (eid, attribute, value) triple only the latest fact
 * counts, and only triples whose latest fact is an 'add' are part of the
 * state. Schema facts (negative eids) are included with their original txs so
 * `restore()` replays them verbatim. The result is ascending by tx, matching
 * restore()'s ordering invariants. The triple key is the JSON-wire form of
 * the value (design/03 tags), which is canonical for every legal stored value.
 */
function currentStateFacts(facts: readonly Fact[]): Fact[] {
	const latestByTriple = new Map<string, Fact>();
	for (const fact of facts) {
		const key = `${typeof fact[0]}:${String(fact[0])}\u0000${fact[1]}\u0000${JSON.stringify(serializeValue(fact[2]))}`;
		latestByTriple.set(key, fact);
	}

	const current: Fact[] = [];
	for (const fact of latestByTriple.values()) {
		if (fact[4] === 'add') {
			current.push(fact);
		}
	}

	return current.sort((left, right) => left[3] - right[3]);
}

/**
 * The raw internal {@link ServerEvent} carries engine values (Date, bigint,
 * frozen ref objects) that JSON.stringify either throws on (bigint) or
 * silently corrupts (refs -> `{}`, Dates -> untagged ISO strings). Every
 * output path — the WS raw fan-out, SSE, and the sync frames — serializes
 * through this so clients always receive the design/03 JSON tags and
 * stringify never throws (B4.3).
 */
function serializeServerEventForWire(event: ServerEvent): JsonObject {
	// Check the single-literal discriminant first: TS cannot exclude the
	// union-typed `'fact:added' | 'fact:retracted'` member from the else
	// branch of a two-sided comparison, but a single `===` literal narrows.
	if (event.type === 'transaction:committed') {
		return {
			type: event.type,
			transaction: serializeTransactionRecord(event.transaction),
			facts: serializeFacts(event.facts)
		};
	}

	return { type: event.type, fact: serializeFact(event.fact) };
}

/**
 * Deserializes tagged values inside a transaction entry tuple (design/03).
 * Schema declaration objects pass through untouched; 4-tuples are mutations,
 * 3-tuples are fact triples.
 */
function deserializeEntry(entry: unknown): unknown {
	if (!Array.isArray(entry)) {
		return entry;
	}

	const copy = entry.slice();
	const valueIndex = copy.length === 4 ? 3 : copy.length === 3 ? 2 : -1;
	if (valueIndex >= 0) {
		copy[valueIndex] = deserializeValue(copy[valueIndex]);
	}

	return copy;
}

export class FatosServer {
	private db = createDatabase();
	private readonly storage: StorageAdapter | null;
	/** True once the storage snapshot has been restored into the in-memory db. */
	private seeded = false;
	/** Serialized persistence pipeline: saves run in commit order, never overlapping. */
	private persistQueue: Promise<void> = Promise.resolve();
	/** First storage-save failure since the last `flush()`, surfaced by `flush()`. */
	private lastPersistError: Error | null = null;
	private server: NodeServer | null = null;
	private listeners = new Set<(event: ServerEvent) => void>();
	private websocketServer: WebSocketServer | null = null;
	private websocketEventUnsubscribe: Unsubscribe | null = null;
	/** Per-client subscribe registry: subscription id -> live handle (design/03). */
	private clientSubscriptions = new Map<WebSocket, Map<string, ClientSubscription>>();
	/** Per-client fact-sync registry (Phase 6): subscription id -> unsubscribe. */
	private syncSubscriptions = new Map<WebSocket, Map<string, { id: string; unsubscribe: Unsubscribe }>>();
	/** Normalized CORS config; `null` disables CORS headers and OPTIONS handling. */
	private readonly cors: NormalizedCors | null;

	constructor(options: FatosServerOptions = {}) {
		this.storage = options.storage ?? null;
		this.cors = normalizeCors(options.cors);
	}

	async start(options: StartOptions = {}): Promise<ServerAddress> {
		if (this.server) {
			return this.getAddress();
		}

		// Seed once per server instance: the in-memory db survives start/stop
		// cycles, so re-running restore() on a non-empty db would throw.
		if (this.storage && !this.seeded) {
			const snapshot = await this.storage.load();
			this.db.restore(snapshot);
			this.seeded = true;
		}

		const host = options.host ?? '127.0.0.1';
		const port = options.port ?? 0;

		this.server = createServer((req, res) => {
			void this.handleRequest(req, res);
		});

		this.websocketServer = new WebSocketServer({ noServer: true });
		this.websocketServer.on('connection', (client) => {
			client.on('message', (raw, isBinary) => {
				if (isBinary) {
					return;
				}

				let text: string;
				if (Array.isArray(raw)) {
					text = Buffer.concat(raw).toString('utf8');
				} else if (Buffer.isBuffer(raw)) {
					text = raw.toString('utf8');
				} else {
					text = Buffer.from(raw).toString('utf8');
				}
				this.handleWebSocketMessage(client, text);
			});
			client.on('close', () => {
				this.disposeClientSubscriptions(client);
			});
		});
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

	async stop(): Promise<void> {
		// Wait for any in-flight storage write so a stopped server has a
		// consistent snapshot on disk/backend (writes never reject — failures
		// are surfaced by flush()).
		await this.persistQueue;
		await this.checkpoint();

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
			return;
		}

		const toClose = this.server;
		this.server = null;
		await new Promise<void>((resolve, reject) => {
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

	private broadcastWebSocketEvent(event: ServerEvent): void {
		if (!this.websocketServer) {
			return;
		}

		// B4.5: the raw fan-out is the DevTools/audit stream (design/03) for
		// bare connections — clients holding no subscribe/sync registration.
		// Clients with active registrations receive their own tailored frames
		// (spec-filtered `facts` / `sync-event`) and would only be re-sent the
		// same data redundantly, so they are excluded.
		const recipients = [...this.websocketServer.clients].filter(
			(client) => client.readyState === 1 && this.isRawStreamRecipient(client)
		);
		if (recipients.length === 0) {
			return;
		}

		// Serialize once and share the string: the payload is identical for
		// every client, so per-client JSON.stringify is N× wasted work on the
		// event loop of every committed transaction. The event is serialized
		// through the wire form first (B4.3): raw engine values (bigint, ref,
		// Date) would throw or corrupt under JSON.stringify.
		const serialized = JSON.stringify(serializeServerEventForWire(event));
		for (const client of recipients) {
			client.send(serialized);
		}
	}

	/**
	 * True when the client holds no subscribe- or sync-protocol entry — a bare
	 * connection watching the raw audit stream (design/03: "the raw
	 * `fact:added` / `transaction:committed` fan-out stays for DevTools/audit
	 * streams").
	 */
	private isRawStreamRecipient(client: WebSocket): boolean {
		return (
			(this.clientSubscriptions.get(client)?.size ?? 0) === 0
			&& (this.syncSubscriptions.get(client)?.size ?? 0) === 0
		);
	}

	/**
	 * P3 subscribe registry protocol (design/03):
	 *
	 *   -> { type: 'subscribe', id, spec, afterTx? }
	 *   <- { type: 'subscribed', id }
	 *   -> on match: { type: 'facts', id, rows }
	 *   <- { type: 'unsubscribe', id }
	 *
	 * With `afterTx`, the client first receives the current query result
	 * (catch-up covering everything committed since that tx), then live
	 * updates. The raw `fact:added` / `transaction:committed` fan-out stays
	 * untouched.
	 */
	private handleWebSocketMessage(client: WebSocket, raw: string): void {
		let message: unknown;
		try {
			message = JSON.parse(raw) as unknown;
		} catch {
			return;
		}

		if (!isObject(message)) {
			return;
		}

		if (message.type === 'subscribe') {
			this.handleSubscribe(client, message);
			return;
		}

		if (message.type === 'sync') {
			this.handleSync(client, message);
			return;
		}

		if (message.type === 'unsubscribe') {
			this.handleUnsubscribe(client, message);
		}
	}

	private handleSubscribe(client: WebSocket, message: JsonObject): void {
		const { id, afterTx } = message;
		if (typeof id !== 'string' || id === '') {
			return;
		}

		if (afterTx !== undefined && (typeof afterTx !== 'number' || !Number.isFinite(afterTx))) {
			return;
		}

		let spec: QuerySpec;
		try {
			spec = deserializeQuerySpec(message.spec);
		} catch {
			return;
		}

		const registry = this.getClientRegistry(client);
		const existing = registry.get(id);
		if (existing) {
			existing.live.dispose();
		}

		const live = this.db.live(spec);
		const subscription: ClientSubscription = { id, live };
		registry.set(id, subscription);

		this.sendWebSocket(client, { type: 'subscribed', id });

		if (afterTx !== undefined) {
			this.sendWebSocket(client, { type: 'facts', id, rows: serializeRows(live.current) });
		}

		live.subscribe((rows) => {
			this.sendWebSocket(client, { type: 'facts', id, rows: serializeRows(rows) });
		});
	}

	private handleUnsubscribe(client: WebSocket, message: JsonObject): void {
		const { id } = message;
		if (typeof id !== 'string') {
			return;
		}

		const registry = this.clientSubscriptions.get(client);
		const subscription = registry?.get(id);
		if (!registry || !subscription) {
			this.disposeSyncSubscription(client, id);
			return;
		}

		subscription.live.dispose();
		registry.delete(id);
		if (registry.size === 0) {
			this.clientSubscriptions.delete(client);
		}
		this.disposeSyncSubscription(client, id);
	}

	private getClientRegistry(client: WebSocket): Map<string, ClientSubscription> {
		let registry = this.clientSubscriptions.get(client);
		if (!registry) {
			registry = new Map();
			this.clientSubscriptions.set(client, registry);
		}

		return registry;
	}

	private disposeClientSubscriptions(client: WebSocket): void {
		const registry = this.clientSubscriptions.get(client);
		if (registry) {
			for (const subscription of registry.values()) {
				subscription.live.dispose();
			}
			this.clientSubscriptions.delete(client);
		}

		const syncRegistry = this.syncSubscriptions.get(client);
		if (syncRegistry) {
			for (const { unsubscribe } of syncRegistry.values()) {
				unsubscribe();
			}
			this.syncSubscriptions.delete(client);
		}
	}

	/**
	 * Phase 6 fact-sync subscription: streams the full fact log + transaction
	 * ledger since `afterTx` (catch-up), then live `transaction:committed`
	 * events — the full-facts counterpart of the spec-scoped subscribe
	 * registry (design/03 `afterTx` catch-up primitive).
	 *
	 *   -> { type: 'sync', id, afterTx?, afterTime? }
	 *   <- { type: 'synced', id }
	 *   <- { type: 'snapshot', id, facts, transactions } // fresh pull (no afterTx):
	 *                                                //   current-state facts + full ledger
	 *   <- { type: 'facts', id, facts }            // afterTx catch-up; a huge
	 *                                            //   full-log pull arrives as
	 *                                            //   multiple chunks
	 *   <- { type: 'transactions', id, transactions } // ledger with tx > afterTx
	 *   <- live: { type: 'sync-event', id, event }
	 *
	 * `afterTime` (ms epoch) is an alternative to `afterTx`: it maps to a tx
	 * boundary via the ledger so the catch-up streams exactly the facts
	 * committed at/after that timestamp ("facts since <time>").
	 *
	 * The live subscription is registered *before* the catch-up is computed
	 * and sent; everything runs synchronously in one event-loop tick, so a
	 * commit can never fall into the gap between the catch-up snapshot and the
	 * live stream.
	 */
	private handleSync(client: WebSocket, message: JsonObject): void {
		const { id, afterTx, afterTime } = message;
		if (typeof id !== 'string' || id === '') {
			return;
		}

		if (afterTx !== undefined && (typeof afterTx !== 'number' || !Number.isFinite(afterTx))) {
			return;
		}

		if (afterTime !== undefined && (typeof afterTime !== 'number' || !Number.isFinite(afterTime))) {
			return;
		}

		const syncRegistry = this.syncSubscriptions.get(client);
		const existing = syncRegistry?.get(id);
		if (existing) {
			existing.unsubscribe();
		}

		const unsubscribe = this.subscribe((event) => {
			if (event.type !== 'transaction:committed') {
				return;
			}
			this.sendWebSocket(client, {
				type: 'sync-event',
				id,
				event: {
					type: event.type,
					transaction: serializeTransactionRecord(event.transaction),
					facts: serializeFacts(event.facts)
				}
			});
		});
		const registry = this.getSyncRegistry(client);
		registry.set(id, { id, unsubscribe });

		this.sendWebSocket(client, { type: 'synced', id });

		// Fresh pulls (no afterTx) get the compact state snapshot (B4.1):
		// current entity facts only — bounded by active state, not history —
		// plus the full ledger so the client's watermark is the real server
		// head. Incremental pulls keep the chunked full-log catch-up below.
		// `afterTime` maps to a tx boundary (catch-up = facts committed
		// at/after that time); an explicit `afterTx` wins over it.
		const effectiveAfterTx = afterTx ?? (afterTime === undefined ? undefined : this.db.txBefore(afterTime));
		if (effectiveAfterTx === undefined) {
			this.sendWebSocket(client, {
				type: 'snapshot',
				id,
				facts: serializeFacts(currentStateFacts(this.db.getFacts())),
				transactions: serializeTransactions(this.db.getTransactions())
			});
			return;
		}

		const facts = this.db.getFacts().filter((fact) => fact[3] > effectiveAfterTx);
		const transactions = this.db.getTransactions().filter(([tx]) => tx > effectiveAfterTx);
		// Stream the catch-up in bounded tx-ordered chunks (the db fact log is
		// append-ordered, so consecutive slices stay ascending by tx). The
		// client accumulates `facts` frames and applies the catch-up when the
		// trailing `transactions` frame arrives; a full-log pull never builds
		// one oversized frame per connection.
		for (let offset = 0; offset < facts.length; offset += SYNC_CATCH_UP_CHUNK) {
			this.sendWebSocket(client, {
				type: 'facts',
				id,
				facts: serializeFacts(facts.slice(offset, offset + SYNC_CATCH_UP_CHUNK))
			});
		}
		this.sendWebSocket(client, { type: 'transactions', id, transactions: serializeTransactions(transactions) });
	}

	private getSyncRegistry(client: WebSocket): Map<string, { id: string; unsubscribe: Unsubscribe }> {
		let registry = this.syncSubscriptions.get(client);
		if (!registry) {
			registry = new Map();
			this.syncSubscriptions.set(client, registry);
		}

		return registry;
	}

	private disposeSyncSubscription(client: WebSocket, id: string): void {
		const registry = this.syncSubscriptions.get(client);
		const subscription = registry?.get(id);
		if (!registry || !subscription) {
			return;
		}

		subscription.unsubscribe();
		registry.delete(id);
		if (registry.size === 0) {
			this.syncSubscriptions.delete(client);
		}
	}

	private sendWebSocket(client: WebSocket, payload: JsonObject): void {
		if (client.readyState !== 1) {
			return;
		}

		client.send(JSON.stringify(payload));
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
			this.persist(transaction, facts);
		}
		return facts;
	}

	/**
	 * Queues a persistence write after the commit. `transact` stays synchronous
	 * (existing API), so writes run on an ordered promise chain: each write
	 * captures its commit's payload and runs strictly after the previous one.
	 * Append-capable adapters record just the committed transaction
	 * (O(transaction size) — no full fact-log serialization); snapshot-only
	 * adapters fall back to saving the whole database state as of this commit.
	 * Failures are captured and rethrown by the next `flush()`.
	 */
	private persist(transaction: TransactionRecord, facts: readonly Fact[]): void {
		const storage = this.storage;
		if (!storage) {
			return;
		}

		if (typeof storage.append === 'function') {
			this.persistQueue = this.persistQueue
				.then(() => storage.append?.(transaction, facts))
				.catch((error: unknown) => {
					this.lastPersistError = error instanceof Error ? error : new Error(String(error));
				});
			return;
		}

		// Snapshot fallback: capture the state as of THIS commit so queued
		// saves never bleed later commits into an earlier save.
		const snapshot = { facts: this.db.getFacts(), transactions: this.db.getTransactions() };
		this.persistQueue = this.persistQueue
			.then(() => storage.save(snapshot))
			.catch((error: unknown) => {
				this.lastPersistError = error instanceof Error ? error : new Error(String(error));
			});
	}

	/**
	 * Awaits all queued storage saves and rethrows the first save failure since
	 * the previous call. Use it before shutting down or before creating a new
	 * server instance seeded from the same adapter.
	 */
	async flush(): Promise<void> {
		await this.persistQueue;
		if (this.lastPersistError) {
			const error = this.lastPersistError;
			this.lastPersistError = null;
			throw error;
		}
	}

	/**
	 * Compacts an append-mode adapter on shutdown: merges the pending append
	 * log into a full snapshot so a restart replays a bounded log (the O(n)
	 * cost moves to one controlled point per process lifetime instead of per
	 * transaction). Best-effort — the append log stays durable if this fails,
	 * so the failure is recorded for `flush()` rather than thrown here.
	 */
	private async checkpoint(): Promise<void> {
		const storage = this.storage;
		if (!storage || typeof storage.append !== 'function') {
			return;
		}

		if (this.db.getFacts().length === 0) {
			return;
		}

		try {
			await storage.save({ facts: this.db.getFacts(), transactions: this.db.getTransactions() });
		} catch (error) {
			this.lastPersistError = error instanceof Error ? error : new Error(String(error));
		}
	}

	private filteredFacts(searchParams: URLSearchParams): readonly Fact[] {
		const txRaw = searchParams.get('tx');
		const sinceRaw = searchParams.get('since');
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

		if (sinceRaw !== null) {
			// Facts committed at/after `since` (ms epoch): map to a tx
			// boundary via the ledger, then keep every fact past it.
			const since = Number(sinceRaw);
			if (!Number.isFinite(since)) {
				throw new Error('Invalid since query value');
			}
			const afterTx = this.db.txBefore(since);
			facts = facts.filter((fact) => fact[3] > afterTx);
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
			res.write(`data: ${JSON.stringify(serializeServerEventForWire(event))}\n\n`);
		});

		req.on('close', () => {
			unsubscribe();
			res.end();
		});
	}

	/**
	 * Tags a response with the CORS headers implied by the request's `Origin`.
	 * With `'same-origin'` only requests whose origin matches the server's own
	 * host are allowed; with an origin allow-list, non-matching origins get no
	 * `access-control-allow-origin` header, so the browser blocks them. The
	 * `vary` on Origin keeps shared caches from replaying one origin's headers
	 * for another.
	 */
	private applyCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
		if (this.cors === null) {
			return;
		}

		const configuredOrigin = this.cors.origin;
		const requestOrigin = req.headers.origin;
		let allowOrigin: string | null;
		if (configuredOrigin === '*') {
			allowOrigin = '*';
		} else if (configuredOrigin === 'same-origin') {
			const selfOrigin = sameOriginOf(req);
			allowOrigin = requestOrigin !== undefined && selfOrigin !== null && requestOrigin === selfOrigin ? requestOrigin : null;
		} else {
			allowOrigin =
				typeof requestOrigin === 'string' && configuredOrigin.includes(requestOrigin) ? requestOrigin : null;
		}

		if (allowOrigin !== null) {
			res.setHeader('access-control-allow-origin', allowOrigin);
		}
		res.setHeader('access-control-allow-methods', this.cors.methods.join(', '));
		res.setHeader('access-control-allow-headers', this.cors.headers.join(', '));
		res.setHeader('vary', 'Origin');
	}

	private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			const method = req.method ?? 'GET';
			const requestUrl = new URL(req.url ?? '/', 'http://localhost');
			const pathname = requestUrl.pathname;

			if (this.cors !== null) {
				this.applyCorsHeaders(req, res);
				if (method === 'OPTIONS') {
					// CORS preflight — browsers send this before a cross-origin
					// `content-type: application/json` POST /transact. Respond
					// with the allowed origin/methods/headers so the app's
					// write-through fetch is allowed to proceed.
					res.statusCode = 204;
					res.end();
					return;
				}
			}

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
				writeJson(res, 200, { facts: serializeFacts(facts) });
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

				// Keep refs branded on the wire so `$ref` tags survive the
				// endpoint (lossless round-trip); core's plain-id default
				// is an in-process ergonomic read shape.
				const entity = this.db.entity(eid, tx, { refs: 'ref' });
				writeJson(res, 200, { entity: serializeEntityState(entity) });
				return;
			}

			if (method === 'GET' && pathname === '/transactions') {
				writeJson(res, 200, {
					transactions: serializeTransactions(this.db.getTransactions())
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
				const entries = (body.entries as unknown[]).map(deserializeEntry) as TransactionEntry[];
				const facts = this.transact(entries, metadata);
				const transaction = this.db.getTransactions().at(-1);
				writeJson(res, 200, {
					facts: serializeFacts(facts),
					transaction: transaction === undefined ? null : serializeTransactionRecord(transaction)
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
					entries = (body.facts as unknown[]).map(deserializeEntry) as Mutation[];
				} else {
					const op = body.op;
					const eid = body.eid;
					const attribute = body.attribute;
					if ((op !== 'add' && op !== 'retract') || typeof eid !== 'number' || typeof attribute !== 'string') {
						writeJson(res, 400, { error: 'Body must include facts array or op/eid/attribute/value' });
						return;
					}

					entries = [[op, eid, attribute, deserializeValue(body.value)]];
				}

				const facts = this.transact(entries, metadata);
				const transaction = this.db.getTransactions().at(-1);
				writeJson(res, 200, {
					facts: serializeFacts(facts),
					transaction: transaction === undefined ? null : serializeTransactionRecord(transaction)
				});
				return;
			}

			if (method === 'POST' && pathname === '/query') {
				const body = await readJsonBody(req);
				if (!isObject(body)) {
					writeJson(res, 400, { error: 'Request body must include a datalog spec' });
					return;
				}

				let spec: QuerySpec;
				try {
					spec = deserializeQuerySpec(body.spec);
				} catch {
					writeJson(res, 400, { error: 'Request body must include a datalog spec' });
					return;
				}

				const txRaw = body.tx;
				if (txRaw !== undefined && (typeof txRaw !== 'number' || !Number.isFinite(txRaw))) {
					writeJson(res, 400, { error: 'Invalid tx query value' });
					return;
				}

				const rows = this.db.query(spec, txRaw);
				writeJson(res, 200, { rows: serializeRows(rows) });
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

export function createFatosServer(options?: FatosServerOptions): FatosServer {
	return new FatosServer(options);
}
