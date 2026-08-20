/**
 * @fatos/client - Browser client
 * 
 * This module provides the in-memory client implementation for the browser.
 * It includes:
 * - In-memory fact store
 * - Query execution
 * - Reactive subscriptions
 * - Server communication (optional)
 */

import {
	createDatabase,
	type DatabaseSnapshot,
	type DiffResult,
	type EntityId,
	type EntityReadOptions,
	type Fact,
	type FactTuple,
	type FactDatabase,
	type FindOptions,
	type InsertMap,
	type LiveQueryOptions,
	type LiveQueryResult,
	type LiveResult,
	type MergeMap,
	type Mutation,
	type OrderBy,
	type OrderDirection,
	type PullPath,
	type QuerySpec,
	type QueryTerm,
	type SchemaInfo,
	type TransactionEntryInput,
	type TransactionEntry,
	type TransactionRecord
} from '@fatos/core';

export const version = '0.0.1';

export type EntityState = Record<string, unknown> & { id: EntityId };
export type Unsubscribe = () => void;

type Listener = () => void;

/** Event names dispatched by {@link FatosClient} on writes (design/03). */
export const FACT_ADDED_EVENT = 'fact:added' as const;
export const FACT_RETRACTED_EVENT = 'fact:retracted' as const;
export const TRANSACTION_COMMITTED_EVENT = 'transaction:committed' as const;

/**
 * Base class for every Fatos client event (design/03). Subclasses add typed
 * payload properties (`.fact`, `.transaction`, `.facts`); the raw payload is
 * always available as `detail`.
 */
export class FatosEvent<D = unknown> extends Event {
	readonly detail: D;

	constructor(type: string, detail: D) {
		super(type);
		this.detail = detail;
	}
}

/** Fired per fact written by `add`, `retract`, or `transact`. */
export class FactEvent extends FatosEvent<{ fact: Fact }> {
	readonly fact: Fact;

	constructor(type: typeof FACT_ADDED_EVENT | typeof FACT_RETRACTED_EVENT, fact: Fact) {
		super(type, { fact });
		this.fact = fact;
	}
}

/** Fired once per committed transaction carrying the record and its facts. */
export class TransactionEvent extends FatosEvent<{ transaction: TransactionRecord; facts: readonly Fact[] }> {
	readonly transaction: TransactionRecord;
	readonly facts: readonly Fact[];

	constructor(transaction: TransactionRecord, facts: readonly Fact[]) {
		super(TRANSACTION_COMMITTED_EVENT, { transaction, facts });
		this.transaction = transaction;
		this.facts = facts;
	}
}

function stableKey(value: unknown): string {
	return JSON.stringify(value);
}

/** True when the object has the `find`/`where` shape of a QuerySpec. */
function isQuerySpec(value: QuerySpec | Record<string, unknown>): value is QuerySpec {
	return 'find' in value && 'where' in value;
}

/** Narrowing predicate for the explicit-dependency `live(deps, fn)` form. */
function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value);
}

export class FatosClient extends EventTarget {
	private dbInternal: FactDatabase;

	constructor(db?: FactDatabase) {
		super();
		this.dbInternal = db ?? createDatabase();
	}

	/**
	 * The underlying core database. The client surface is the complete
	 * authoring/reading API and emits events for every write, so prefer the
	 * client methods; this handle is for advanced use (e.g. sync planning).
	 */
	get db(): FactDatabase {
		return this.dbInternal;
	}

	/**
	 * Sugar over `addEventListener('transaction:committed', ...)` — fires after
	 * every write that commits at least one fact (design/03).
	 */
	subscribe(listener: Listener): Unsubscribe {
		const handler = (): void => {
			listener();
		};
		this.addEventListener(TRANSACTION_COMMITTED_EVENT, handler);
		return () => {
			this.removeEventListener(TRANSACTION_COMMITTED_EVENT, handler);
		};
	}

	/** Dispatches per-fact events followed by `transaction:committed` (design/03). */
	private emitCommitted(facts: readonly Fact[]): void {
		if (facts.length === 0) {
			return;
		}

		for (const fact of facts) {
			this.dispatchEvent(
				new FactEvent(fact[4] === 'retract' ? FACT_RETRACTED_EVENT : FACT_ADDED_EVENT, fact)
			);
		}

		const transactions = this.dbInternal.getTransactions();
		const transaction = transactions[transactions.length - 1];
		if (transaction !== undefined) {
			this.dispatchEvent(new TransactionEvent(transaction, facts));
		}
	}

	add(eid: EntityId, attribute: string, value: unknown): Fact;
	add(tuple: FactTuple): Fact;
	add(eidOrTuple: EntityId | FactTuple, attribute?: string, value?: unknown): Fact {
		let fact: Fact;
		if (Array.isArray(eidOrTuple)) {
			const tuple = eidOrTuple as FactTuple;
			fact = this.dbInternal.add(tuple);
		} else {
			fact = this.dbInternal.add(eidOrTuple as EntityId, attribute as string, value);
		}
		this.emitCommitted([fact]);
		return fact;
	}

	retract(eid: EntityId, attribute: string, value: unknown): Fact;
	retract(tuple: FactTuple): Fact;
	retract(eidOrTuple: EntityId | FactTuple, attribute?: string, value?: unknown): Fact {
		let fact: Fact;
		if (Array.isArray(eidOrTuple)) {
			const tuple = eidOrTuple as FactTuple;
			fact = this.dbInternal.retract(tuple);
		} else {
			fact = this.dbInternal.retract(eidOrTuple as EntityId, attribute as string, value);
		}
		this.emitCommitted([fact]);
		return fact;
	}

	transact(entries: TransactionEntryInput[], metadata?: Record<string, unknown>): Fact[] {
		const facts = this.dbInternal.transact(entries, metadata);
		this.emitCommitted(facts);
		return facts;
	}

	insert(input: InsertMap): EntityId;
	insert(input: InsertMap[]): EntityId[];
	insert(input: InsertMap | InsertMap[]): EntityId | EntityId[] {
		return this.insertMaps(input);
	}

	upsert(input: InsertMap): EntityId;
	upsert(input: InsertMap[]): EntityId[];
	upsert(input: InsertMap | InsertMap[]): EntityId | EntityId[] {
		return this.insertMaps(input);
	}

	/** Object-map authoring (design/02): commits a `planInsert` plan through the event path. */
	private insertMaps(input: InsertMap | InsertMap[]): EntityId | EntityId[] {
		const plan = this.dbInternal.planInsert(input);
		if (plan.entries.length > 0) {
			this.transact(plan.entries);
		}
		return Array.isArray(input) ? plan.results : plan.results[0];
	}

	set(eid: EntityId, attribute: string, value: unknown): Fact[];
	set(eid: EntityId, changes: Record<string, unknown>): Fact[];
	set(eid: EntityId, attributeOrChanges: string | Record<string, unknown>, value?: unknown): Fact[] {
		return this.applyChanges(eid, attributeOrChanges, value);
	}

	patch(eid: EntityId, attribute: string, value: unknown): Fact[];
	patch(eid: EntityId, changes: Record<string, unknown>): Fact[];
	patch(eid: EntityId, attributeOrChanges: string | Record<string, unknown>, value?: unknown): Fact[] {
		return this.applyChanges(eid, attributeOrChanges, value);
	}

	/** Diff-based update (design/02): commits the `planSet` diff through the event path. */
	private applyChanges(
		eid: EntityId,
		attributeOrChanges: string | Record<string, unknown>,
		value?: unknown
	): Fact[] {
		const mutations =
			typeof attributeOrChanges === 'string'
				? this.dbInternal.planSet(eid, attributeOrChanges, value)
				: this.dbInternal.planSet(eid, attributeOrChanges);
		if (mutations.length === 0) {
			return [];
		}
		return this.transact(mutations);
	}

	merge(input: MergeMap): EntityId[] {
		const plan = this.dbInternal.planMerge(input);
		if (plan.entries.length > 0) {
			this.transact(plan.entries);
		}
		return plan.results;
	}

	/** Single-entity form of {@link merge}; accepts numeric or string ids. */
	mergeEntity(eid: EntityId, attrs: InsertMap): EntityId {
		const plan = this.dbInternal.planMergeEntity(eid, attrs);
		if (plan.entries.length > 0) {
			this.transact(plan.entries);
		}
		return plan.results[0];
	}

	getFacts(): readonly Fact[] {
		return this.dbInternal.getFacts();
	}

	getFactsByEntity(eid: EntityId): readonly Fact[] {
		return this.dbInternal.getFactsByEntity(eid);
	}

	getFactsByAttribute(attribute: string): readonly Fact[] {
		return this.dbInternal.getFactsByAttribute(attribute);
	}

	getFactsByEntityAttribute(eid: EntityId, attribute: string): readonly Fact[] {
		return this.dbInternal.getFactsByEntityAttribute(eid, attribute);
	}

	getFactsByAttributeValue(attribute: string, value: unknown): readonly Fact[] {
		return this.dbInternal.getFactsByAttributeValue(attribute, value);
	}

	getTransactions(): readonly TransactionRecord[] {
		return this.dbInternal.getTransactions();
	}

	/** The facts committed in transaction `tx` (empty when `tx` is unknown). */
	transactionFacts(tx: number): Fact[] {
		return this.dbInternal.transactionFacts(tx);
	}

	/** The transaction ledger record for `tx`, or null when unknown. */
	transaction(tx: number): TransactionRecord | null {
		return this.dbInternal.transaction(tx);
	}

	getSchema(ident: string): SchemaInfo | null {
		return this.dbInternal.getSchema(ident);
	}

	getSchemas(): SchemaInfo[] {
		return this.dbInternal.getSchemas();
	}

	entity(eid: EntityId, tx?: number, options?: EntityReadOptions): EntityState | null {
		return this.dbInternal.entity(eid, tx, options) as EntityState | null;
	}

	/**
	 * Finds entities matching `criteria`. The second argument mirrors core
	 * `FactDatabase.find`: a tx number (time-travel read) or `FindOptions`
	 * (`orderBy` / `limit` / `offset` / `select`).
	 */
	find(criteria: Record<string, unknown>, options?: number | FindOptions): EntityState[] {
		return this.dbInternal.find(criteria, options) as EntityState[];
	}

	query(spec: QuerySpec, tx?: number): QueryTerm[][] {
		return this.dbInternal.query(spec, tx);
	}

	/** Dot-path selection (design/02 pull): resolves ref attributes into nested objects. */
	pull(eid: EntityId, paths: PullPath, tx?: number): EntityState | null {
		return this.dbInternal.pull(eid, paths, tx);
	}

	/**
	 * The facts committed in transactions (min(txA, txB), max(txA, txB)],
	 * grouped by operation — the primitive for DevTools timelines and undo/redo.
	 */
	diff(txA: number, txB: number): DiffResult {
		return this.dbInternal.diff(txA, txB);
	}

	/** Replaces the whole database state with a snapshot (core `restore`). */
	restore(snapshot: DatabaseSnapshot): void {
		this.dbInternal.restore(snapshot);
	}

	/**
	 * Live query (design/03), delegated to the underlying core database:
	 * memoized `current` result plus change subscription. Three forms —
	 * `live(fn)` access tracking (the selector receives the client as its
	 * first argument), `live(deps, fn)` explicit dependencies, and
	 * `live(specOrCriteria)` direct QuerySpec / find-criteria form.
	 */
	live<T>(fn: (client: FatosClient) => T): LiveResult<T>;
	live<T>(deps: readonly string[], fn: () => T): LiveResult<T>;
	live(spec: QuerySpec): LiveResult<QueryTerm[][]>;
	live(criteria: Record<string, unknown>): LiveResult<EntityState[]>;
	live<T>(
		input: ((client: FatosClient) => T) | readonly string[] | QuerySpec | Record<string, unknown>,
		fn?: () => T
	): LiveResult<T> | LiveResult<QueryTerm[][]> | LiveResult<EntityState[]> {
		// Delegate per form so the core overloads resolve unambiguously.
		if (typeof input === 'function') {
			// Access-tracking form: pass the client through (design/03); the
			// core tracker records the delegated db reads underneath.
			return this.dbInternal.live(() => input(this));
		}

		if (isStringArray(input)) {
			if (fn === undefined) {
				throw new Error('live(deps, fn) requires a selector function');
			}
			return this.dbInternal.live(input, fn);
		}

		if (isQuerySpec(input)) {
			return this.dbInternal.live(input);
		}

		return this.dbInternal.live(input);
	}

	/**
	 * Live query as an async iterable (design/03), delegated to the underlying
	 * core database: yields the initial result, then each subsequent change.
	 * Cancellation via `AbortSignal`, iterator `return()`/`throw()`, or
	 * `dispose()`.
	 */
	liveQuery(spec: QuerySpec, options?: LiveQueryOptions): LiveQueryResult<QueryTerm[][]>;
	liveQuery(criteria: Record<string, unknown>, options?: LiveQueryOptions): LiveQueryResult<EntityState[]>;
	liveQuery<T>(
		input: QuerySpec | Record<string, unknown>,
		options?: LiveQueryOptions
	): LiveQueryResult<T> | LiveQueryResult<QueryTerm[][]> | LiveQueryResult<EntityState[]> {
		return this.dbInternal.liveQuery(input, options);
	}

	atTransaction(tx: number): {
		entity: (eid: EntityId, options?: EntityReadOptions) => EntityState | null;
		find: (criteria: Record<string, unknown>, options?: FindOptions) => EntityState[];
		query: (spec: QuerySpec) => QueryTerm[][];
		pull: (eid: EntityId, paths: PullPath) => EntityState | null;
	} {
		return {
			entity: (eid: EntityId, options?: EntityReadOptions) => this.entity(eid, tx, options),
			find: (criteria: Record<string, unknown>, options?: FindOptions) =>
				this.find(criteria, { ...options, tx }),
			query: (spec: QuerySpec) => this.query(spec, tx),
			pull: (eid: EntityId, paths: PullPath) => this.pull(eid, paths, tx)
		};
	}

	/** Time-travel read view alias of {@link atTransaction} (core parity). */
	at(tx: number): {
		entity: (eid: EntityId, options?: EntityReadOptions) => EntityState | null;
		find: (criteria: Record<string, unknown>, options?: FindOptions) => EntityState[];
		query: (spec: QuerySpec) => QueryTerm[][];
		pull: (eid: EntityId, paths: PullPath) => EntityState | null;
	} {
		return this.atTransaction(tx);
	}

	/**
	 * The last committed transaction whose timestamp is `<= timestamp`, or 0
	 * when none qualifies yet — maps a clock time to a tx id (design/02 time
	 * travel by time).
	 */
	txAtOrBefore(timestamp: number): number {
		return this.dbInternal.txAtOrBefore(timestamp);
	}

	/**
	 * A time-travel read view "as of" a clock time: `atTransaction(txAtOrBefore(t))`
	 * — the client-shaped view (entity / find / query) at that transaction.
	 */
	atTime(timestamp: number): {
		entity: (eid: EntityId, options?: EntityReadOptions) => EntityState | null;
		find: (criteria: Record<string, unknown>, options?: FindOptions) => EntityState[];
		query: (spec: QuerySpec) => QueryTerm[][];
		pull: (eid: EntityId, paths: PullPath) => EntityState | null;
	} {
		return this.atTransaction(this.dbInternal.txAtOrBefore(timestamp));
	}

	/**
	 * Observes a find-criteria query (B4.4): delivers the initial result
	 * synchronously, then only results that actually changed. Built on
	 * `db.live(criteria)` so writes touching attributes outside the criteria
	 * never wake the observer — core prunes by attribute (AEVT) before the
	 * result diff, so the callback is only invoked on relevant changes.
	 */
	observe(criteria: Record<string, unknown>, callback: (entities: EntityState[]) => void): Unsubscribe {
		const live = this.dbInternal.live(criteria);
		callback(live.current);
		live.subscribe(callback);
		return () => live.dispose();
	}

	/**
	 * Observes a Datalog query (B4.4), same contract as {@link observe}: built
	 * on `db.live(spec)`, whose where-clause attributes narrow relevance.
	 */
	observeQuery(spec: QuerySpec, callback: (rows: QueryTerm[][]) => void): Unsubscribe {
		const live = this.dbInternal.live(spec);
		callback(live.current);
		live.subscribe(callback);
		return () => live.dispose();
	}

	/**
	 * Observes one entity (B4.4). Uses the access-tracking `db.live(fn)` form —
	 * `db.entity` reads are tracked (core live.test.ts 'tracks reads through
	 * db.entity proxies'). The whole entity is the payload, so the handle
	 * cannot narrow to recorded attributes (a brand-new attribute on the
	 * entity must still wake the observer); it falls back to diffing every
	 * write and the callback fires only when the entity actually changed.
	 */
	observeEntity(eid: EntityId, callback: (entity: EntityState | null) => void): Unsubscribe {
		const live = this.dbInternal.live(() => this.entity(eid));
		callback(live.current);
		live.subscribe(callback);
		return () => live.dispose();
	}

	observeTransactions(callback: (transactions: readonly TransactionRecord[]) => void): Unsubscribe {
		let previous = stableKey(this.getTransactions());
		callback(this.getTransactions());

		return this.subscribe(() => {
			const nextTransactions = this.getTransactions();
			const next = stableKey(nextTransactions);
			if (next === previous) {
				return;
			}

			previous = next;
			callback(nextTransactions);
		});
	}
}

export function createClient(db?: FactDatabase): FatosClient {
	return new FatosClient(db);
}

export {
	SyncingClient,
	applyDeltaToClient,
	catchUpDelta,
	createSyncingClient,
	factsToTransactionEntries,
	lastAppliedTx,
	maxTxOf,
	parseSyncMessage
} from './sync';
export type {
	ApplyDeltaResult,
	FactLog,
	SyncServerMessage,
	SyncSocket,
	SyncStatus,
	SyncTransactionEvent,
	SyncingClientOptions,
	WriteResult
} from './sync';

export type {
	DatabaseSnapshot,
	DiffResult,
	EntityId,
	EntityReadOptions,
	Fact,
	FactTuple,
	FactDatabase,
	FindOptions,
	InsertMap,
	LiveQueryOptions,
	LiveQueryResult,
	LiveResult,
	MergeMap,
	Mutation,
	OrderBy,
	OrderDirection,
	PullPath,
	QuerySpec,
	QueryTerm,
	SchemaInfo,
	TransactionEntryInput,
	TransactionEntry,
	TransactionRecord
};
