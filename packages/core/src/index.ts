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
export type EntityId = number | string;

export type Fact = readonly [
	eid: EntityId,
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
	eid: EntityId,
	attribute: string,
	value: unknown
];

export type FactTuple = readonly [
	eid: EntityId,
	attribute: string,
	value: unknown
];

export type ValueType = 'string' | 'number' | 'boolean' | 'null' | 'unknown';
export type Cardinality = 'one' | 'many';

export type SchemaDeclaration = {
	ident: string;
	valueType: ValueType;
	cardinality: Cardinality;
};

export type TransactionEntry = Mutation | SchemaDeclaration;
export type TransactionEntryInput = TransactionEntry | FactTuple;

type AttributeSchema = {
	eid: number;
	ident: string;
	valueType: ValueType;
	cardinality: Cardinality;
};

export type SchemaInfo = {
	eid: number;
	ident: string;
	valueType: ValueType;
	cardinality: Cardinality;
};

export type QueryTerm = string | number | boolean | null;
export type QueryClause = readonly [entity: QueryTerm, attribute: string, value: QueryTerm];
export type QuerySpec = {
	find: string[];
	where: QueryClause[];
};

type EntityState = Record<string, unknown> & { id: EntityId };

type EAVTIndex = Map<EntityId, Map<string, Fact[]>>;
type AEVTIndex = Map<string, Map<EntityId, Fact[]>>;
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

function isSchemaDeclaration(entry: TransactionEntryInput): entry is SchemaDeclaration {
	return !Array.isArray(entry);
}

function isMutation(entry: TransactionEntryInput): entry is Mutation {
	return Array.isArray(entry) && entry.length === 4 && (entry[0] === 'add' || entry[0] === 'retract');
}

function isFactTuple(entry: TransactionEntryInput): entry is FactTuple {
	return Array.isArray(entry) && entry.length === 3;
}

function matchesValueType(value: unknown, valueType: ValueType): boolean {
	if (valueType === 'unknown') {
		return true;
	}

	if (valueType === 'null') {
		return value === null;
	}

	return typeof value === valueType;
}

export class FactDatabase {
	private facts: Fact[] = [];
	private transactions: TransactionRecord[] = [];
	private eavt: EAVTIndex = new Map();
	private aevt: AEVTIndex = new Map();
	private avet: AVETIndex = new Map();
	private nextTx = 1;
	private nextSchemaEid = -1;
	private attributeSchemas = new Map<string, AttributeSchema>();
	private schemaByIdent = new Map<string, number>();

	private commitTransaction(metadata?: Record<string, unknown>): TransactionRecord {
		const tx = this.nextTx++;
		const timestamp = Date.now();
		const transaction: TransactionRecord = [tx, timestamp, metadata ?? null];
		this.transactions.push(transaction);
		return transaction;
	}

	private appendFact(tx: number, op: FactOperation, eid: EntityId, attribute: string, value: unknown): Fact {
		const fact: Fact = [eid, attribute, value, tx, op];
		this.facts.push(fact);

		const entityAttributes = this.eavt.get(eid) ?? new Map<string, Fact[]>();
		const eavtFacts = entityAttributes.get(attribute) ?? [];
		eavtFacts.push(fact);
		entityAttributes.set(attribute, eavtFacts);
		this.eavt.set(eid, entityAttributes);

		const attributeEntities = this.aevt.get(attribute) ?? new Map<EntityId, Fact[]>();
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

	add(eid: EntityId, attribute: string, value: unknown): Fact;
	add(tuple: FactTuple): Fact;
	add(eidOrTuple: EntityId | FactTuple, attribute?: string, value?: unknown): Fact {
		const mutation = Array.isArray(eidOrTuple)
			? ['add', eidOrTuple[0], eidOrTuple[1], eidOrTuple[2]] as const
			: ['add', eidOrTuple, attribute as string, value] as const;
		const facts = this.transact([mutation]);
		return facts[0] as Fact;
	}

	retract(eid: EntityId, attribute: string, value: unknown): Fact;
	retract(tuple: FactTuple): Fact;
	retract(eidOrTuple: EntityId | FactTuple, attribute?: string, value?: unknown): Fact {
		const mutation = Array.isArray(eidOrTuple)
			? ['retract', eidOrTuple[0], eidOrTuple[1], eidOrTuple[2]] as const
			: ['retract', eidOrTuple, attribute as string, value] as const;
		const facts = this.transact([mutation]);
		return facts[0] as Fact;
	}

	transact(entries: TransactionEntryInput[], metadata?: Record<string, unknown>): Fact[] {
		if (entries.length === 0) {
			return [];
		}

		const mutations: Mutation[] = [];
		for (const entry of entries) {
			if (isSchemaDeclaration(entry)) {
				mutations.push(...this.schemaDeclarationToFacts(entry));
				continue;
			}

			if (isFactTuple(entry)) {
				mutations.push(['add', entry[0], entry[1], entry[2]]);
				continue;
			}

			if (isMutation(entry)) {
				mutations.push(entry);
				continue;
			}

			throw new Error('Invalid transaction entry format');
		}

		this.validateMutations(mutations);

		const [tx] = this.commitTransaction(metadata);
		return mutations.map(([op, eid, attribute, value]) => {
			const fact = this.appendFact(tx, op, eid, attribute, value);
			this.onFactCommitted(fact);
			return fact;
		});
	}

	getFacts(): readonly Fact[] {
		return this.facts.slice();
	}

	getFactsByEntity(eid: EntityId): readonly Fact[] {
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

	getFactsByEntityAttribute(eid: EntityId, attribute: string): readonly Fact[] {
		return this.eavt.get(eid)?.get(attribute)?.slice() ?? [];
	}

	getFactsByAttributeValue(attribute: string, value: unknown): readonly Fact[] {
		return this.avet.get(attribute)?.get(valueKey(value))?.slice() ?? [];
	}

	getTransactions(): readonly TransactionRecord[] {
		return this.transactions.slice();
	}

	getSchema(ident: string): SchemaInfo | null {
		const schema = this.attributeSchemas.get(ident);
		if (!schema) {
			return null;
		}

		return {
			eid: schema.eid,
			ident: schema.ident,
			valueType: schema.valueType,
			cardinality: schema.cardinality
		};
	}

	getSchemas(): SchemaInfo[] {
		return [...this.attributeSchemas.values()]
			.map((schema) => ({
				eid: schema.eid,
				ident: schema.ident,
				valueType: schema.valueType,
				cardinality: schema.cardinality
			}))
			.sort((left, right) => left.ident.localeCompare(right.ident));
	}

	entity(eid: EntityId, tx?: number): EntityState | null {
		const txLimit = normalizeTxLimit(tx);
		const state = new Map<string, unknown | Set<unknown>>();

		for (const [factEid, attribute, value, factTx, op] of this.facts) {
			if (factEid !== eid || factTx > txLimit) {
				continue;
			}

			const schema = this.attributeSchemas.get(attribute);
			if (schema?.cardinality === 'many') {
				const current = state.get(attribute);
				const values = current instanceof Set ? current : new Set<unknown>();

				if (op === 'add') {
					values.add(value);
				} else {
					values.delete(value);
				}

				if (values.size === 0) {
					state.delete(attribute);
				} else {
					state.set(attribute, values);
				}
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
			if (value instanceof Set) {
				entity[attribute] = Array.from(value);
				continue;
			}

			entity[attribute] = value;
		}

		return entity;
	}

	find(criteria: Record<string, unknown>, tx?: number): EntityState[] {
		const txLimit = normalizeTxLimit(tx);
		const eids = new Set<EntityId>();

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

	private materializedTriples(tx?: number): Array<[EntityId, string, QueryTerm]> {
		const txLimit = normalizeTxLimit(tx);
		const eids = new Set<EntityId>();

		for (const [eid, , , factTx] of this.facts) {
			if (factTx <= txLimit) {
				eids.add(eid);
			}
		}

		const triples: Array<[EntityId, string, QueryTerm]> = [];
		for (const eid of eids) {
			const entity = this.entity(eid, txLimit);
			if (!entity) {
				continue;
			}

			for (const [attribute, value] of Object.entries(entity)) {
				if (attribute === 'id') {
					continue;
				}

				if (Array.isArray(value)) {
					for (const item of value) {
						if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' || item === null) {
							triples.push([eid, attribute, item]);
						}
					}
					continue;
				}

				if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
					triples.push([eid, attribute, value]);
				}
			}
		}

		return triples;
	}

	private schemaDeclarationToFacts(schema: SchemaDeclaration): Mutation[] {
		const existingSchema = this.attributeSchemas.get(schema.ident);
		if (existingSchema) {
			if (existingSchema.valueType !== schema.valueType || existingSchema.cardinality !== schema.cardinality) {
				throw new Error(`Schema conflict for ${schema.ident}`);
			}

			return [];
		}

		const schemaEid = this.nextSchemaEid--;
		return [
			['add', schemaEid, 'db/ident', schema.ident],
			['add', schemaEid, 'db/valueType', schema.valueType],
			['add', schemaEid, 'db/cardinality', schema.cardinality]
		];
	}

	private onFactCommitted(fact: Fact): void {
		const [eid, attribute, value, , op] = fact;
		if (op !== 'add') {
			return;
		}

		if (attribute === 'db/ident' && typeof value === 'string' && typeof eid === 'number') {
			this.schemaByIdent.set(value, eid);
			this.attributeSchemas.set(value, {
				eid,
				ident: value,
				valueType: 'unknown',
				cardinality: 'one'
			});
			return;
		}

		const ident = [...this.schemaByIdent.entries()].find(([, schemaEid]) => schemaEid === eid)?.[0];
		if (!ident) {
			return;
		}

		const schema = this.attributeSchemas.get(ident);
		if (!schema) {
			return;
		}

		if (attribute === 'db/valueType' && typeof value === 'string') {
			schema.valueType = value as ValueType;
		}

		if (attribute === 'db/cardinality' && (value === 'one' || value === 'many')) {
			schema.cardinality = value;
		}
	}

	private validateMutations(mutations: Mutation[]): void {
		const manyState = new Map<string, Set<unknown>>();
		const oneState = new Map<string, unknown>();

		for (const [op, eid, attribute, value] of mutations) {
			const schema = this.attributeSchemas.get(attribute);
			if (!schema) {
				continue;
			}

			if (!matchesValueType(value, schema.valueType)) {
				throw new Error(`Invalid value type for ${attribute}. Expected ${schema.valueType}`);
			}

			const key = `${eid}:${attribute}`;
			if (schema.cardinality === 'many') {
				const current = manyState.get(key) ?? new Set(this.activeValues(eid, attribute));
				if (op === 'add') {
					current.add(value);
				} else {
					current.delete(value);
				}
				manyState.set(key, current);
				continue;
			}

			const current = oneState.has(key) ? oneState.get(key) : this.activeValues(eid, attribute)[0];
			if (op === 'add') {
				if (current !== undefined && !Object.is(current, value)) {
					throw new Error(`Cardinality conflict for ${attribute}: expected one value`);
				}
				oneState.set(key, value);
				continue;
			}

			if (current !== undefined && Object.is(current, value)) {
				oneState.delete(key);
			}
		}
	}

	private activeValues(eid: EntityId, attribute: string): unknown[] {
		const schema = this.attributeSchemas.get(attribute);
		if (schema?.cardinality === 'many') {
			const values = new Set<unknown>();
			for (const [factEid, factAttr, value, , op] of this.facts) {
				if (factEid !== eid || factAttr !== attribute) {
					continue;
				}

				if (op === 'add') {
					values.add(value);
				} else {
					values.delete(value);
				}
			}
			return Array.from(values);
		}

		let current: unknown | undefined;
		for (const [factEid, factAttr, value, , op] of this.facts) {
			if (factEid !== eid || factAttr !== attribute) {
				continue;
			}

			if (op === 'add') {
				current = value;
			} else if (current !== undefined && Object.is(current, value)) {
				current = undefined;
			}
		}

		return current === undefined ? [] : [current];
	}
}

export function createDatabase(): FactDatabase {
	return new FactDatabase();
}
