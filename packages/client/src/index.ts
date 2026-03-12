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
	type Fact,
	type FactDatabase,
	type Mutation,
	type QuerySpec,
	type QueryTerm,
	type SchemaInfo,
	type TransactionEntry,
	type TransactionRecord
} from '../../core/src/index';

export const version = '0.0.1';

export type EntityState = Record<string, unknown> & { id: number };
export type Unsubscribe = () => void;

type Listener = () => void;

function stableKey(value: unknown): string {
	return JSON.stringify(value);
}

export class FatosClient {
	private db: FactDatabase;
	private listeners = new Set<Listener>();

	constructor(db?: FactDatabase) {
		this.db = db ?? createDatabase();
	}

	subscribe(listener: Listener): Unsubscribe {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private notify(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}

	add(eid: number, attribute: string, value: unknown): Fact {
		const fact = this.db.add(eid, attribute, value);
		this.notify();
		return fact;
	}

	retract(eid: number, attribute: string, value: unknown): Fact {
		const fact = this.db.retract(eid, attribute, value);
		this.notify();
		return fact;
	}

	transact(entries: TransactionEntry[], metadata?: Record<string, unknown>): Fact[] {
		const facts = this.db.transact(entries, metadata);
		if (facts.length > 0) {
			this.notify();
		}
		return facts;
	}

	getFacts(): readonly Fact[] {
		return this.db.getFacts();
	}

	getFactsByEntity(eid: number): readonly Fact[] {
		return this.db.getFactsByEntity(eid);
	}

	getFactsByAttribute(attribute: string): readonly Fact[] {
		return this.db.getFactsByAttribute(attribute);
	}

	getFactsByEntityAttribute(eid: number, attribute: string): readonly Fact[] {
		return this.db.getFactsByEntityAttribute(eid, attribute);
	}

	getFactsByAttributeValue(attribute: string, value: unknown): readonly Fact[] {
		return this.db.getFactsByAttributeValue(attribute, value);
	}

	getTransactions(): readonly TransactionRecord[] {
		return this.db.getTransactions();
	}

	getSchema(ident: string): SchemaInfo | null {
		return this.db.getSchema(ident);
	}

	getSchemas(): SchemaInfo[] {
		return this.db.getSchemas();
	}

	entity(eid: number, tx?: number): EntityState | null {
		return this.db.entity(eid, tx) as EntityState | null;
	}

	find(criteria: Record<string, unknown>, tx?: number): EntityState[] {
		return this.db.find(criteria, tx) as EntityState[];
	}

	query(spec: QuerySpec, tx?: number): QueryTerm[][] {
		return this.db.query(spec, tx);
	}

	atTransaction(tx: number) {
		return {
			entity: (eid: number) => this.entity(eid, tx),
			find: (criteria: Record<string, unknown>) => this.find(criteria, tx),
			query: (spec: QuerySpec) => this.query(spec, tx)
		};
	}

	observe(criteria: Record<string, unknown>, callback: (entities: EntityState[]) => void): Unsubscribe {
		let previous = stableKey(this.find(criteria));
		callback(this.find(criteria));

		return this.subscribe(() => {
			const nextResult = this.find(criteria);
			const next = stableKey(nextResult);
			if (next === previous) {
				return;
			}

			previous = next;
			callback(nextResult);
		});
	}

	observeQuery(spec: QuerySpec, callback: (rows: QueryTerm[][]) => void): Unsubscribe {
		let previous = stableKey(this.query(spec));
		callback(this.query(spec));

		return this.subscribe(() => {
			const nextRows = this.query(spec);
			const next = stableKey(nextRows);
			if (next === previous) {
				return;
			}

			previous = next;
			callback(nextRows);
		});
	}

	observeEntity(eid: number, callback: (entity: EntityState | null) => void): Unsubscribe {
		let previous = stableKey(this.entity(eid));
		callback(this.entity(eid));

		return this.subscribe(() => {
			const nextEntity = this.entity(eid);
			const next = stableKey(nextEntity);
			if (next === previous) {
				return;
			}

			previous = next;
			callback(nextEntity);
		});
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

export type {
	Fact,
	FactDatabase,
	Mutation,
	QuerySpec,
	QueryTerm,
	SchemaInfo,
	TransactionEntry,
	TransactionRecord
};
