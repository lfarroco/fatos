/**
 * @fatos/client sync — client-server synchronization (Phase 6).
 *
 * `createSyncingClient` keeps a local `FatosClient` in sync with a Fatos
 * server over a single WebSocket using the `sync` message (the full-facts
 * variant of the design/03 subscribe registry with `afterTx` catch-up):
 *
 * ```
 * → { type: 'sync', id, afterTx? }
 * ← { type: 'synced', id }
 * ← { type: 'facts', id, facts }            // catch-up: facts with tx > afterTx (may span multiple frames)
 * ← { type: 'transactions', id, transactions } // catch-up: ledger with tx > afterTx
 * ← { type: 'sync-event', id, event }       // live: transaction:committed
 * ```
 *
 * Strategies (see docs/sync-strategies.md):
 * - **Full snapshot pull** — first connect (empty local client): the server
 *   streams the whole fact log + ledger and the local client is rebuilt with
 *   `db.restore()`, which replays schema facts verbatim.
 * - **afterTx incremental catch-up** — reconnect: `afterTx` is the last
 *   applied server tx; only the delta is streamed and replayed per
 *   transaction via `client.transact()`. Schema facts in the delta are
 *   converted back into schema declarations (see `factsToTransactionEntries`);
 *   replaying them as raw facts would remap the negative schema eids as
 *   tempids and corrupt the local schema.
 * - **Live updates** — each `transaction:committed` sync-event is transacted
 *   onto the same client instance (so React bindings keep working), and the
 *   watermark advances only after a successful apply.
 *
 * If an incremental apply ever fails, the module falls back to a full pull on
 * the next reconnect, which rebuilds the client instance (see
 * `onClientReplaced`). The socket is injectable so tests run against a fake.
 */

import { createDatabase, deserializeValue } from '@fatos/core';
import type {
	Cardinality,
	Fact,
	FactOperation,
	Mutation,
	SchemaDeclaration,
	TransactionEntryInput,
	TransactionRecord,
	ValueType
} from '@fatos/core';
import { FatosClient } from './index';

export type SyncStatus = 'idle' | 'connecting' | 'synced' | 'reconnecting' | 'stopped';

/** The minimal WebSocket surface the syncing client drives. */
export type SyncSocket = {
	readonly readyState: number;
	send(data: string): void;
	close(): void;
	addEventListener(type: string, listener: (event: unknown) => void): void;
	removeEventListener(type: string, listener: (event: unknown) => void): void;
};

/** One live committed transaction as streamed by the server's `sync` message. */
export type SyncTransactionEvent = {
	type: 'transaction:committed';
	transaction: TransactionRecord;
	facts: readonly Fact[];
};

/** Server → client frames of the `sync` protocol. */
export type SyncServerMessage =
	| { type: 'synced'; id: string }
	| { type: 'facts'; id: string; facts: readonly Fact[] }
	| { type: 'transactions'; id: string; transactions: readonly TransactionRecord[] }
	| { type: 'sync-event'; id: string; event: SyncTransactionEvent };

export type FactLog = {
	facts: readonly Fact[];
	transactions: readonly TransactionRecord[];
};

export type ApplyDeltaResult = {
	/** The highest tx fully applied before any failure (or all of them). */
	lastApplied: number | null;
	/** Set when a transaction failed to apply; `lastApplied` is then the last success. */
	error?: Error;
};

export type SyncingClientOptions = {
	/** WebSocket URL of the Fatos server, e.g. `ws://localhost:4000/ws`. */
	url: string;
	/** Injectable socket factory (tests inject a fake; defaults to `new WebSocket(url)`). */
	createSocket?: () => SyncSocket;
	/** Start from this client instead of a fresh one. Full pulls replace it. */
	client?: FatosClient;
	/** Base reconnect delay in ms (doubles per attempt, capped at `maxReconnectDelayMs`). */
	reconnectDelayMs?: number;
	/** Upper bound for the reconnect backoff in ms. */
	maxReconnectDelayMs?: number;
	/** Called on status transitions. */
	onStatusChange?: (status: SyncStatus) => void;
	/** Called with recoverable errors (malformed frames, failed applies). */
	onError?: (error: Error) => void;
	/**
	 * Called after a full snapshot pull replaced the client instance (the
	 * fallback after an incremental apply failure). Re-bind your app to
	 * `syncingClient.client`.
	 */
	onClientReplaced?: (client: FatosClient) => void;
};

let syncIdCounter = 0;

const SCHEMA_ATTRIBUTES: ReadonlySet<string> = new Set([
	'db/ident',
	'db/valueType',
	'db/cardinality',
	'db/unique',
	'db/ref'
]);

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEntityId(value: unknown): boolean {
	return typeof value === 'number' || typeof value === 'string';
}

function isFactTuple(value: unknown): value is Fact {
	if (!Array.isArray(value) || value.length !== 5) {
		return false;
	}

	const [eid, attribute, , tx, op] = value as unknown[];
	return (
		isEntityId(eid)
		&& typeof attribute === 'string'
		&& Number.isInteger(tx)
		&& (tx as number) >= 1
		&& (op === 'add' || op === 'retract')
	);
}

function isTransactionTuple(value: unknown): value is TransactionRecord {
	if (!Array.isArray(value) || value.length !== 3) {
		return false;
	}

	const [tx, timestamp, metadata] = value as unknown[];
	return (
		Number.isInteger(tx)
		&& (tx as number) >= 1
		&& typeof timestamp === 'number'
		&& (metadata === null || isObject(metadata))
	);
}

function isSyncTransactionEvent(value: unknown): value is SyncTransactionEvent {
	if (!isObject(value) || value.type !== 'transaction:committed') {
		return false;
	}

	return isTransactionTuple(value.transaction) && Array.isArray(value.facts) && value.facts.every(isFactTuple);
}

/**
 * Parses and validates one server frame of the `sync` protocol. Returns `null`
 * for anything that is not valid JSON or does not match the message shapes —
 * malformed frames are dropped, never thrown.
 */
export function parseSyncMessage(text: string): SyncServerMessage | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch {
		return null;
	}

	if (!isObject(parsed) || typeof parsed['id'] !== 'string' || parsed['id'] === '') {
		return null;
	}

	const id = parsed['id'];
	switch (parsed['type']) {
		case 'synced':
			return { type: 'synced', id };
		case 'facts':
			if (Array.isArray(parsed['facts']) && parsed['facts'].every(isFactTuple)) {
				return { type: 'facts', id, facts: parsed['facts'] };
			}
			return null;
		case 'transactions':
			if (Array.isArray(parsed['transactions']) && parsed['transactions'].every(isTransactionTuple)) {
				return { type: 'transactions', id, transactions: parsed['transactions'] };
			}
			return null;
		case 'sync-event':
			if (isSyncTransactionEvent(parsed['event'])) {
				return { type: 'sync-event', id, event: parsed['event'] };
			}
			return null;
		default:
			return null;
	}
}
/** The highest tx in the log, or `null` for an empty log. */
export function lastAppliedTx(log: FactLog): number | null {
	return log.transactions.length === 0 ? null : log.transactions[log.transactions.length - 1][0];
}

/** The highest tx mentioned by facts or transactions — the full-log watermark. */
export function maxTxOf(log: FactLog): number | null {
	let max: number | null = null;
	for (const fact of log.facts) {
		if (max === null || fact[3] > max) {
			max = fact[3];
		}
	}
	for (const [tx] of log.transactions) {
		if (max === null || tx > max) {
			max = tx;
		}
	}
	return max;
}

/** Keeps only facts/transactions committed strictly after `afterTx` — the incremental delta. */
export function catchUpDelta(log: FactLog, afterTx: number): FactLog {
	return {
		facts: log.facts.filter((fact) => fact[3] > afterTx),
		transactions: log.transactions.filter(([tx]) => tx > afterTx)
	};
}

function isValueType(value: unknown): value is ValueType {
	return (
		value === 'string'
		|| value === 'number'
		|| value === 'boolean'
		|| value === 'null'
		|| value === 'date'
		|| value === 'bigint'
		|| value === 'ref'
		|| value === 'unknown'
	);
}

function isCardinality(value: unknown): value is Cardinality {
	return value === 'one' || value === 'many';
}

/**
 * Converts a committed transaction's resolved facts back into transact
 * entries. Schema facts (negative eids + `db/*` attributes) are grouped per
 * schema entity and reconstructed as `SchemaDeclaration` objects — replaying
 * them through `transact()` as raw facts would remap the negative eids as
 * tempids and corrupt the local schema. All other facts become
 * `['add'|'retract', eid, attribute, value]` mutations. Declarations come
 * first so data facts are validated against the schema they declare.
 */
export function factsToTransactionEntries(facts: readonly Fact[]): TransactionEntryInput[] {
	const schemaGroups = new Map<number, Map<string, unknown>>();
	const mutations: Mutation[] = [];

	for (const [eid, attribute, value, , op] of facts) {
		if (op === 'add' && typeof eid === 'number' && eid < 0 && SCHEMA_ATTRIBUTES.has(attribute)) {
			let group = schemaGroups.get(eid);
			if (group === undefined) {
				group = new Map<string, unknown>();
				schemaGroups.set(eid, group);
			}
			group.set(attribute, value);
			continue;
		}

		mutations.push([op as FactOperation, eid, attribute, value]);
	}

	const declarations: SchemaDeclaration[] = [];
	for (const group of schemaGroups.values()) {
		const ident = group.get('db/ident');
		const valueType = group.get('db/valueType');
		const cardinality = group.get('db/cardinality');
		if (typeof ident !== 'string' || !isValueType(valueType) || !isCardinality(cardinality)) {
			continue; // malformed schema group: the full-pull fallback rebuilds verbatim
		}

		const declaration: SchemaDeclaration = { ident, valueType, cardinality };
		const unique = group.get('db/unique');
		if (unique === 'identity' || unique === 'value') {
			declaration.unique = unique;
		}
		if (group.get('db/ref') === true) {
			declaration.ref = true;
		}
		declarations.push(declaration);
	}

	return [...declarations, ...mutations];
}

function transactionMetadata(log: FactLog, tx: number): Record<string, unknown> | undefined {
	const transaction = log.transactions.find(([transactionTx]) => transactionTx === tx);
	return transaction?.[2] ?? undefined;
}

/**
 * Replays a catch-up delta onto `client`, one server transaction at a time
 * (ascending), advancing `lastApplied` per success. A failed transaction stops
 * the replay and reports `error`; because `transact()` is atomic per
 * transaction, the caller can resume from `lastApplied` on the next reconnect.
 */
export function applyDeltaToClient(client: FatosClient, delta: FactLog): ApplyDeltaResult {
	let lastApplied: number | null = null;
	for (const [tx] of delta.transactions) {
		const txFacts = delta.facts.filter((fact) => fact[3] === tx);
		try {
			if (txFacts.length > 0) {
				client.transact(factsToTransactionEntries(txFacts), transactionMetadata(delta, tx));
			}
			lastApplied = tx;
		} catch (error) {
			return {
				lastApplied,
				error: error instanceof Error ? error : new Error(String(error))
			};
		}
	}

	return { lastApplied };
}

function defaultCreateSocket(url: string): SyncSocket {
	if (typeof WebSocket === 'undefined') {
		throw new Error(
			'createSyncingClient: no WebSocket available in this environment; pass options.createSocket'
		);
	}
	return new WebSocket(url) as unknown as SyncSocket;
}

/**
 * The live sync handle returned by {@link createSyncingClient}. Start/stop are
 * idempotent; the client instance is stable unless a full-pull fallback
 * replaces it (`onClientReplaced` fires then).
 */
export class SyncingClient {
	readonly id: string;
	private readonly createSocket: () => SyncSocket;
	private readonly reconnectDelayMs: number;
	private readonly maxReconnectDelayMs: number;
	private readonly onStatusChange?: (status: SyncStatus) => void;
	private readonly onError?: (error: Error) => void;
	private readonly onClientReplaced?: (client: FatosClient) => void;

	private clientInternal: FatosClient;
	private statusInternal: SyncStatus = 'idle';
	private lastAppliedTxInternal: number | null = null;
	private socket: SyncSocket | null = null;
	private stopped = true;
	private hasSyncedOnce = false;
	private needsFullResync = false;
	private reconnectAttempts = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private pendingFacts: readonly Fact[] = [];

	constructor(options: SyncingClientOptions) {
		this.id = `sync-${syncIdCounter++}`;
		this.createSocket = options.createSocket ?? (() => defaultCreateSocket(options.url));
		this.reconnectDelayMs = options.reconnectDelayMs ?? 1000;
		this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 30000;
		this.onStatusChange = options.onStatusChange;
		this.onError = options.onError;
		this.onClientReplaced = options.onClientReplaced;
		this.clientInternal = options.client ?? new FatosClient();
	}

	/** The local mirror client. Stable across reconnects; replaced on a full-pull fallback. */
	get client(): FatosClient {
		return this.clientInternal;
	}

	getStatus(): SyncStatus {
		return this.statusInternal;
	}

	/** The highest server transaction fully applied locally, or `null` before the first sync. */
	getLastAppliedTx(): number | null {
		return this.lastAppliedTxInternal;
	}

	/** Connects and starts syncing. Safe to call again after `stop()`. */
	start(): void {
		if (!this.stopped) {
			return;
		}
		this.stopped = false;
		this.connect();
	}

	/** Closes the socket and stops reconnecting. Safe to call twice. */
	stop(): void {
		this.stopped = true;
		if (this.reconnectTimer !== null) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.socket?.close();
		this.socket = null;
		this.setStatus('stopped');
	}

	private setStatus(status: SyncStatus): void {
		if (this.statusInternal === status) {
			return;
		}
		this.statusInternal = status;
		this.onStatusChange?.(status);
	}

	private reportError(error: Error): void {
		this.onError?.(error);
	}

	private connect(): void {
		if (this.stopped) {
			return;
		}

		this.pendingFacts = [];
		this.setStatus(this.hasSyncedOnce ? 'reconnecting' : 'connecting');

		const socket = this.createSocket();
		this.socket = socket;
		socket.addEventListener('open', () => this.handleOpen());
		socket.addEventListener('message', (event) => this.handleMessage(event));
		socket.addEventListener('close', () => this.handleClose());
		socket.addEventListener('error', () => {
			// Browsers and ws follow an error with close; if not, close now so
			// the reconnect path runs.
			if (this.socket !== null && this.socket.readyState !== 3) {
				this.socket.close();
			}
		});
	}

	private handleOpen(): void {
		if (this.stopped || this.socket === null) {
			return;
		}

		const afterTx = this.needsFullResync ? undefined : (this.lastAppliedTxInternal ?? undefined);
		this.socket.send(JSON.stringify({ type: 'sync', id: this.id, afterTx }));
	}

	private handleMessage(event: unknown): void {
		const data = (event as { data?: unknown }).data;
		if (typeof data !== 'string') {
			return;
		}

		const message = parseSyncMessage(data);
		if (message === null || message.id !== this.id) {
			this.reportError(new Error('sync: dropped an unexpected or malformed server frame'));
			return;
		}

		switch (message.type) {
			case 'synced':
				this.hasSyncedOnce = true;
				this.reconnectAttempts = 0;
				this.setStatus('synced');
				break;
			case 'facts':
				// Catch-up facts may arrive as multiple frames in ascending tx
				// order; accumulate until the 'transactions' frame applies them.
				this.pendingFacts = [...this.pendingFacts, ...message.facts];
				break;
			case 'transactions':
				this.applyCatchUp(this.pendingFacts, message.transactions);
				break;
			case 'sync-event':
				this.applyLiveTransaction(message.event);
				break;
		}
	}

	private handleClose(): void {
		this.socket = null;
		if (this.stopped) {
			return;
		}

		const delay = Math.min(
			this.reconnectDelayMs * 2 ** this.reconnectAttempts,
			this.maxReconnectDelayMs
		);
		this.reconnectAttempts += 1;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, delay);
	}

	private applyCatchUp(facts: readonly Fact[], transactions: readonly TransactionRecord[]): void {
		const deserialized = facts.map(
			(fact) => [fact[0], fact[1], deserializeValue(fact[2]), fact[3], fact[4]] as Fact
		);

		if (this.needsFullResync || this.lastAppliedTxInternal === null) {
			this.rebuildClient({ facts: deserialized, transactions });
			this.needsFullResync = false;
			this.setStatus('synced');
			return;
		}

		const delta = catchUpDelta({ facts: deserialized, transactions }, this.lastAppliedTxInternal);
		const result = applyDeltaToClient(this.clientInternal, delta);
		if (result.error !== undefined) {
			this.needsFullResync = true;
			this.reportError(
				new Error(
					`sync: catch-up apply failed at tx ${String(result.lastApplied ?? 'start')}: ${result.error.message}`
				)
			);
			this.socket?.close();
			return;
		}

		if (result.lastApplied !== null) {
			this.lastAppliedTxInternal = result.lastApplied;
		}
		this.setStatus('synced');
	}

	private applyLiveTransaction(event: SyncTransactionEvent): void {
		const tx = event.transaction[0];
		if (this.lastAppliedTxInternal !== null && tx <= this.lastAppliedTxInternal) {
			return; // stale/duplicate frame (defensive)
		}

		try {
			const facts = event.facts.map(
				(fact) => [fact[0], fact[1], deserializeValue(fact[2]), fact[3], fact[4]] as Fact
			);
			if (facts.length > 0) {
				this.clientInternal.transact(factsToTransactionEntries(facts), event.transaction[2] ?? undefined);
			}
			this.lastAppliedTxInternal = tx;
		} catch (error) {
			this.needsFullResync = true;
			this.reportError(
				error instanceof Error
					? new Error(`sync: live apply failed at tx ${String(tx)}: ${error.message}`)
					: new Error(`sync: live apply failed at tx ${String(tx)}`)
			);
			this.socket?.close();
		}
	}

	/**
	 * Full-pull fallback: rebuilds the mirror from the whole log with
	 * `db.restore()` (schema facts replay verbatim). The client instance is
	 * replaced; `onClientReplaced` fires so the app can re-bind.
	 */
	private rebuildClient(log: FactLog): void {
		const db = createDatabase();
		db.restore(log);
		const next = new FatosClient(db);
		this.clientInternal = next;
		this.lastAppliedTxInternal = maxTxOf(log);
		this.onClientReplaced?.(next);
	}
}

/**
 * Creates a syncing client that mirrors a Fatos server into a local
 * `FatosClient` (see module docs and docs/sync-strategies.md). Call
 * `start()` to connect and `stop()` to disconnect; reconnects use the last
 * applied tx as `afterTx`.
 */
export function createSyncingClient(options: SyncingClientOptions): SyncingClient {
	return new SyncingClient(options);
}

