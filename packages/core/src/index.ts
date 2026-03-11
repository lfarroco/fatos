/**
 * @fatos/core - Core database engine
 * 
 * This module provides the core temporal fact database implementation.
 * It includes:
 * - Fact storage and management
 * - Transaction handling
 * - Index structures (EAVT, AEVT, AVET)
 * - Query engine (Datalog-style)
 */

export const version = '0.0.1';

export type FactOperation = 'add' | 'retract';

export type Fact = readonly [
	eid: number,
	attribute: string,
	value: unknown,
	tx: number,
	op: FactOperation
];

export type TransactionRecord = readonly [
	tx: number,
	timestamp: number,
	metadata: Record<string, unknown> | null
];

export type Mutation = readonly [
	op: FactOperation,
	eid: number,
	attribute: string,
	value: unknown
];

export type QueryTerm = string | number | boolean | null;
export type QueryClause = readonly [entity: QueryTerm, attribute: string, value: QueryTerm];
export type QuerySpec = {
	find: string[];
	where: QueryClause[];
};

type EntityState = Record<string, unknown> & { id: number };

type EAVTIndex = Map<number, Map<string, Fact[]>>;
type AEVTIndex = Map<string, Map<number, Fact[]>>;
type AVETIndex = Map<string, Map<string, Fact[]>>;

function normalizeTxLimit(tx?: number): number {
	return tx ?? Number.POSITIVE_INFINITY;
}

function valueKey(value: unknown): string {
	if (value === null) {
		return 'null';
	}

	const type = typeof value;
	if (type === 'object' || type === 'function') {
		return `${type}:${JSON.stringify(value)}`;
	}

	return `${type}:${String(value)}`;
}

function isVariable(term: QueryTerm): term is string {
	return typeof term === 'string' && term.startsWith('?');
}

export class FactDatabase {
	private facts: Fact[] = [];
	private transactions: TransactionRecord[] = [];
	private eavt: EAVTIndex = new Map();
	private aevt: AEVTIndex = new Map();
	private avet: AVETIndex = new Map();
	private nextTx = 1;

	private commitTransaction(metadata?: Record<string, unknown>): TransactionRecord {
		const tx = this.nextTx++;
		const timestamp = Date.now();
		const transaction: TransactionRecord = [tx, timestamp, metadata ?? null];
		this.transactions.push(transaction);
		return transaction;
	}

	private appendFact(tx: number, op: FactOperation, eid: number, attribute: string, value: unknown): Fact {
		const fact: Fact = [eid, attribute, value, tx, op];
		this.facts.push(fact);

		const entityAttributes = this.eavt.get(eid) ?? new Map<string, Fact[]>();
		const eavtFacts = entityAttributes.get(attribute) ?? [];
		eavtFacts.push(fact);
		entityAttributes.set(attribute, eavtFacts);
		this.eavt.set(eid, entityAttributes);

		const attributeEntities = this.aevt.get(attribute) ?? new Map<number, Fact[]>();
		const aevtFacts = attributeEntities.get(eid) ?? [];
		aevtFacts.push(fact);
		attributeEntities.set(eid, aevtFacts);
		this.aevt.set(attribute, attributeEntities);

		const attributeValues = this.avet.get(attribute) ?? new Map<string, Fact[]>();
		const avetKey = valueKey(value);
		const avetFacts = attributeValues.get(avetKey) ?? [];
		avetFacts.push(fact);
		attributeValues.set(avetKey, avetFacts);
		this.avet.set(attribute, attributeValues);

		return fact;
	}

	add(eid: number, attribute: string, value: unknown): Fact {
		const [tx] = this.commitTransaction();
		return this.appendFact(tx, 'add', eid, attribute, value);
	}

	retract(eid: number, attribute: string, value: unknown): Fact {
		const [tx] = this.commitTransaction();
		return this.appendFact(tx, 'retract', eid, attribute, value);
	}

	transact(mutations: Mutation[], metadata?: Record<string, unknown>): Fact[] {
		if (mutations.length === 0) {
			return [];
		}

		const [tx] = this.commitTransaction(metadata);
		return mutations.map(([op, eid, attribute, value]) => this.appendFact(tx, op, eid, attribute, value));
	}

	getFacts(): readonly Fact[] {
		return this.facts.slice();
	}

	getFactsByEntity(eid: number): readonly Fact[] {
		const entityAttributes = this.eavt.get(eid);
		if (!entityAttributes) {
			return [];
		}

		const facts: Fact[] = [];
		for (const attributeFacts of entityAttributes.values()) {
			facts.push(...attributeFacts);
		}

		return facts.sort((left, right) => left[3] - right[3]);
	}

	getFactsByAttribute(attribute: string): readonly Fact[] {
		const attributeEntities = this.aevt.get(attribute);
		if (!attributeEntities) {
			return [];
		}

		const facts: Fact[] = [];
		for (const entityFacts of attributeEntities.values()) {
			facts.push(...entityFacts);
		}

		return facts.sort((left, right) => left[3] - right[3]);
	}

	getFactsByEntityAttribute(eid: number, attribute: string): readonly Fact[] {
		return this.eavt.get(eid)?.get(attribute)?.slice() ?? [];
	}

	getFactsByAttributeValue(attribute: string, value: unknown): readonly Fact[] {
		return this.avet.get(attribute)?.get(valueKey(value))?.slice() ?? [];
	}

	getTransactions(): readonly TransactionRecord[] {
		return this.transactions.slice();
	}

	entity(eid: number, tx?: number): EntityState | null {
		const txLimit = normalizeTxLimit(tx);
		const state = new Map<string, unknown>();

		for (const [factEid, attribute, value, factTx, op] of this.facts) {
			if (factEid !== eid || factTx > txLimit) {
				continue;
			}

			if (op === 'add') {
				state.set(attribute, value);
			} else if (Object.is(state.get(attribute), value)) {
				state.delete(attribute);
			}
		}

		if (state.size === 0) {
			return null;
		}

		const entity: EntityState = { id: eid };
		for (const [attribute, value] of state) {
			entity[attribute] = value;
		}

		return entity;
	}

	find(criteria: Record<string, unknown>, tx?: number): EntityState[] {
		const txLimit = normalizeTxLimit(tx);
		const eids = new Set<number>();

		for (const [eid, , , factTx] of this.facts) {
			if (factTx <= txLimit) {
				eids.add(eid);
			}
		}

		const matches: EntityState[] = [];
		for (const eid of eids) {
			const entity = this.entity(eid, txLimit);
			if (!entity) {
				continue;
			}

			const doesMatch = Object.entries(criteria).every(([key, value]) => Object.is(entity[key], value));
			if (doesMatch) {
				matches.push(entity);
			}
		}

		return matches;
	}

	query(spec: QuerySpec, tx?: number): QueryTerm[][] {
		const triples = this.materializedTriples(tx);
		let bindings: Array<Record<string, QueryTerm>> = [{}];

		for (const [entityTerm, attribute, valueTerm] of spec.where) {
			const nextBindings: Array<Record<string, QueryTerm>> = [];

			for (const binding of bindings) {
				for (const [eid, factAttribute, value] of triples) {
					if (factAttribute !== attribute) {
						continue;
					}

					const withEntity = this.bindTerm(binding, entityTerm, eid);
					if (!withEntity) {
						continue;
					}

					const withValue = this.bindTerm(withEntity, valueTerm, value);
					if (!withValue) {
						continue;
					}

					nextBindings.push(withValue);
				}
			}

			bindings = nextBindings;
		}

		const seen = new Set<string>();
		const rows: QueryTerm[][] = [];
		for (const binding of bindings) {
			const row = spec.find.map((term) => {
				if (isVariable(term as QueryTerm)) {
					return binding[term] ?? null;
				}

				return term as QueryTerm;
			});

			const rowKey = JSON.stringify(row);
			if (seen.has(rowKey)) {
				continue;
			}

			seen.add(rowKey);
			rows.push(row);
		}

		return rows;
	}

	private bindTerm(
		binding: Record<string, QueryTerm>,
		term: QueryTerm,
		actualValue: QueryTerm
	): Record<string, QueryTerm> | null {
		if (!isVariable(term)) {
			return Object.is(term, actualValue) ? binding : null;
		}

		if (!(term in binding)) {
			return {
				...binding,
				[term]: actualValue
			};
		}

		return Object.is(binding[term], actualValue) ? binding : null;
	}

	private materializedTriples(tx?: number): Array<[number, string, QueryTerm]> {
		const txLimit = normalizeTxLimit(tx);
		const eids = new Set<number>();

		for (const [eid, , , factTx] of this.facts) {
			if (factTx <= txLimit) {
				eids.add(eid);
			}
		}

		const triples: Array<[number, string, QueryTerm]> = [];
		for (const eid of eids) {
			const entity = this.entity(eid, txLimit);
			if (!entity) {
				continue;
			}

			for (const [attribute, value] of Object.entries(entity)) {
				if (attribute === 'id') {
					continue;
				}

				if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
					triples.push([eid, attribute, value]);
				}
			}
		}

		return triples;
	}
}

export function createDatabase(): FactDatabase {
	return new FactDatabase();
}
