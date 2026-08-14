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

/**
 * Brand symbols for reference values. A value is a reference iff one of these
 * symbols is present on it; a plain number is never a reference (design/01).
 */
export const REF_BRAND = Symbol('fatos/ref');
export const TEMP_BRAND = Symbol('fatos/temp');
export const LOOKUP_REF_BRAND = Symbol('fatos/lookupRef');

export type ScalarValue = string | number | boolean | null;
export type LookupRef = {
	readonly [LOOKUP_REF_BRAND]: readonly [attribute: string, value: ScalarValue];
};
export type TempHandle = {
	readonly [TEMP_BRAND]: string;
};
export type RefTarget = EntityId | TempHandle | LookupRef;
export type Ref = {
	readonly [REF_BRAND]: RefTarget;
};
export type RefValue = Ref | TempHandle | LookupRef;

/** The set of values the engine accepts at transaction time (arrays are kept verbatim). */
export type Value = string | number | boolean | null | Date | bigint | RefValue | unknown[];

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

/** Entity id position that accepts tempids (negative numbers and temp() handles). */
export type InputEid = EntityId | TempHandle;

/** A resolved (committed) mutation: tempids have been replaced with entity ids. */
export type Mutation = readonly [
	op: FactOperation,
	eid: EntityId,
	attribute: string,
	value: unknown
];

/** A mutation as supplied by the caller; tempids are still allowed. */
export type MutationInput = readonly [
	op: FactOperation,
	eid: InputEid,
	attribute: string,
	value: unknown
];

export type FactTuple = readonly [
	eid: InputEid,
	attribute: string,
	value: unknown
];

export type ValueType = 'string' | 'number' | 'boolean' | 'null' | 'date' | 'bigint' | 'ref' | 'unknown';
export type Cardinality = 'one' | 'many';
export type Unique = 'identity' | 'value';

export type SchemaDeclaration = {
	ident: string;
	valueType: ValueType;
	cardinality: Cardinality;
	unique?: Unique;
	ref?: boolean;
};

export type TransactionEntry = MutationInput | SchemaDeclaration;
export type TransactionEntryInput = TransactionEntry | FactTuple;

type AttributeSchema = {
	eid: number;
	ident: string;
	valueType: ValueType;
	cardinality: Cardinality;
	unique?: Unique;
	ref?: boolean;
};

export type SchemaInfo = {
	eid: number;
	ident: string;
	valueType: ValueType;
	cardinality: Cardinality;
	unique?: Unique;
	ref?: boolean;
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

/**
 * Creates a reference to an entity. Accepts a plain id, a `temp()` handle, or a
 * `lookupRef()`. A plain number is never a reference — callers must wrap it.
 */
export function ref(target: RefTarget): Ref {
	if (typeof target === 'number' && Number.isNaN(target)) {
		throw new Error('ref() target cannot be NaN');
	}

	if (
		typeof target !== 'number' &&
		typeof target !== 'string' &&
		!isTemp(target) &&
		!isLookupRef(target)
	) {
		throw new Error('ref() expects an entity id, temp(), or lookupRef()');
	}

	return Object.freeze({ [REF_BRAND]: target });
}

let tempCounter = 0;

/**
 * Creates a tempid handle for use inside a single transaction. Repeated uses of
 * the same label (or the same handle object) within one transaction resolve to
 * the same fresh entity id.
 */
export function temp(label?: string): TempHandle {
	return Object.freeze({ [TEMP_BRAND]: label ?? `temp-${tempCounter++}` });
}

/**
 * References an entity by a unique attribute value (enables `db/unique:
 * 'identity'` upserts in P1). Stored as-is in P0.
 */
export function lookupRef(pair: readonly [attribute: string, value: ScalarValue]): LookupRef {
	if (typeof pair[0] !== 'string' || !isScalarValue(pair[1])) {
		throw new Error('lookupRef() expects [attribute, scalar value]');
	}

	return Object.freeze({ [LOOKUP_REF_BRAND]: Object.freeze([pair[0], pair[1]] as const) });
}

function isScalarValue(value: unknown): value is ScalarValue {
	return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

export function isRef(value: unknown): value is Ref {
	return typeof value === 'object' && value !== null && REF_BRAND in value;
}

export function isTemp(value: unknown): value is TempHandle {
	return typeof value === 'object' && value !== null && TEMP_BRAND in value;
}

export function isLookupRef(value: unknown): value is LookupRef {
	return typeof value === 'object' && value !== null && LOOKUP_REF_BRAND in value;
}

/**
 * Canonical identity key for a stored value. Used by the AVET index, entity
 * state dedup (cardinality-many), find matching, and unique-constraint
 * tracking. Date is keyed by ms epoch, BigInt by its string form, refs by
 * their target.
 */
function valueKey(value: unknown): string {
	if (value === null) {
		return 'null';
	}

	if (value instanceof Date) {
		return `date:${value.getTime()}`;
	}

	if (typeof value === 'bigint') {
		return `bigint:${value.toString()}`;
	}

	if (isRef(value)) {
		return `ref:${refTargetKey(value[REF_BRAND])}`;
	}

	if (isTemp(value)) {
		return `temp:${value[TEMP_BRAND]}`;
	}

	if (isLookupRef(value)) {
		return `lookupRef:${value[LOOKUP_REF_BRAND][0]}:${valueKey(value[LOOKUP_REF_BRAND][1])}`;
	}

	const type = typeof value;
	if (type === 'object' || type === 'function') {
		return `${type}:${JSON.stringify(value)}`;
	}

	return `${type}:${String(value)}`;
}

function refTargetKey(target: RefTarget): string {
	if (isTemp(target)) {
		return `temp:${target[TEMP_BRAND]}`;
	}

	if (isLookupRef(target)) {
		return `lookupRef:${target[LOOKUP_REF_BRAND][0]}:${valueKey(target[LOOKUP_REF_BRAND][1])}`;
	}

	return `${typeof target}:${String(target)}`;
}

/** Value equality for read-side matching (find criteria, many-attribute dedup). */
function sameValue(left: unknown, right: unknown): boolean {
	return valueKey(left) === valueKey(right);
}

/**
 * Rejects values the data model does not support, at transaction time:
 * NaN / ±Infinity numbers, invalid Dates, opaque objects, and non-values
 * (undefined / functions / symbols). Branded refs/tempids/lookupRefs and
 * arrays are allowed.
 */
function assertSupportedValue(value: unknown, attribute: string): void {
	if (value === undefined) {
		throw new Error(`Invalid value for ${attribute}: undefined is not a supported value`);
	}

	if (typeof value === 'number' && !Number.isFinite(value)) {
		throw new Error(`Invalid number for ${attribute}: NaN and ±Infinity are not supported`);
	}

	if (value instanceof Date && Number.isNaN(value.getTime())) {
		throw new Error(`Invalid date for ${attribute}: Date with NaN time is not supported`);
	}

	if (
		typeof value === 'object' &&
		value !== null &&
		!(value instanceof Date) &&
		!Array.isArray(value) &&
		!isRef(value) &&
		!isTemp(value) &&
		!isLookupRef(value)
	) {
		throw new Error(
			`Invalid value for ${attribute}: opaque objects are not supported (use ref()/temp()/lookupRef() or a scalar)`
		);
	}

	if (typeof value === 'function' || typeof value === 'symbol') {
		throw new Error(`Invalid value for ${attribute}: ${typeof value} is not a supported value`);
	}
}

function isVariable(term: QueryTerm): term is string {
	return typeof term === 'string' && term.startsWith('?');
}

function isQueryTerm(value: unknown): value is QueryTerm {
	return (
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'boolean' ||
		value === null
	);
}

/**
 * Fast dedup key for a result row. Rows only ever contain QueryTerms (strings,
 * numbers, booleans, null), so this mirrors JSON.stringify's keying for those
 * values — including its collisions (NaN and Infinity -> "null", -0 -> "0",
 * quoted/escaped strings) — without the array/object machinery.
 */
function rowKey(row: QueryTerm[]): string {
	let key = '[';
	for (let i = 0; i < row.length; i += 1) {
		if (i > 0) {
			key += ',';
		}

		const value = row[i];
		if (value === null) {
			key += 'null';
			continue;
		}

		if (typeof value === 'string') {
			key += JSON.stringify(value);
			continue;
		}

		if (typeof value === 'number') {
			key += Number.isFinite(value) ? (Object.is(value, -0) ? '0' : String(value)) : 'null';
			continue;
		}

		key += value ? 'true' : 'false';
	}

	return `${key}]`;
}

function isSchemaDeclaration(entry: TransactionEntryInput): entry is SchemaDeclaration {
	return !Array.isArray(entry);
}

function isMutation(entry: TransactionEntryInput): entry is MutationInput {
	return Array.isArray(entry) && entry.length === 4 && (entry[0] === 'add' || entry[0] === 'retract');
}

function isFactTuple(entry: TransactionEntryInput): entry is FactTuple {
	return Array.isArray(entry) && entry.length === 3;
}

function matchesValueType(value: unknown, valueType: ValueType): boolean {
	switch (valueType) {
		case 'unknown':
			return true;
		case 'null':
			return value === null;
		case 'date':
			return value instanceof Date;
		case 'bigint':
			return typeof value === 'bigint';
		case 'ref':
			return isRef(value) || isLookupRef(value);
		default:
			return typeof value === valueType;
	}
}

export class FactDatabase {
	private facts: Fact[] = [];
	private transactions: TransactionRecord[] = [];
	private eavt: EAVTIndex = new Map();
	private aevt: AEVTIndex = new Map();
	private avet: AVETIndex = new Map();
	private nextTx = 1;
	private nextSchemaEid = -1;
	private nextEntityEid = 1;
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

	add(eid: InputEid, attribute: string, value: unknown): Fact;
	add(tuple: FactTuple): Fact;
	add(eidOrTuple: InputEid | FactTuple, attribute?: string, value?: unknown): Fact {
		const mutation: MutationInput = Array.isArray(eidOrTuple)
			? ['add', eidOrTuple[0], eidOrTuple[1], eidOrTuple[2]]
			: ['add', eidOrTuple, attribute as string, value];
		const facts = this.transact([mutation]);
		return facts[0] as Fact;
	}

	retract(eid: InputEid, attribute: string, value: unknown): Fact;
	retract(tuple: FactTuple): Fact;
	retract(eidOrTuple: InputEid | FactTuple, attribute?: string, value?: unknown): Fact {
		const mutation: MutationInput = Array.isArray(eidOrTuple)
			? ['retract', eidOrTuple[0], eidOrTuple[1], eidOrTuple[2]]
			: ['retract', eidOrTuple, attribute as string, value];
		const facts = this.transact([mutation]);
		return facts[0] as Fact;
	}

	transact(entries: TransactionEntryInput[], metadata?: Record<string, unknown>): Fact[] {
		if (entries.length === 0) {
			return [];
		}

		const mutations: Mutation[] = [];
		const tempids = new Map<string, number>();

		for (const entry of entries) {
			if (isSchemaDeclaration(entry)) {
				// Schema facts carry internal negative eids; they are never tempids.
				mutations.push(...this.schemaDeclarationToFacts(entry));
				continue;
			}

			let input: MutationInput;
			if (isFactTuple(entry)) {
				input = ['add', entry[0], entry[1], entry[2]];
			} else if (isMutation(entry)) {
				input = entry;
			} else {
				throw new Error('Invalid transaction entry format');
			}

			mutations.push(this.resolveTempids(input, tempids));
		}

		this.validateMutations(mutations);

		const [tx] = this.commitTransaction(metadata);
		return mutations.map(([op, eid, attribute, value]) => {
			const fact = this.appendFact(tx, op, eid, attribute, value);
			this.onFactCommitted(fact);
			return fact;
		});
	}

	/**
	 * Resolves tempids (negative entity ids and temp() handles) to fresh positive
	 * entity ids. Repeated occurrences of the same tempid within this transaction
	 * resolve to the same id; the mapping is scoped to the transaction.
	 */
	private resolveTempids(mutation: MutationInput, tempids: Map<string, number>): Mutation {
		return [mutation[0], this.resolveEid(mutation[1], tempids), mutation[2], this.resolveValue(mutation[3], tempids)];
	}

	private resolveEid(eid: InputEid, tempids: Map<string, number>): EntityId {
		if (typeof eid === 'number') {
			return eid < 0 ? this.tempidId(`n:${eid}`, tempids) : eid;
		}

		if (isTemp(eid)) {
			return this.tempidId(`t:${eid[TEMP_BRAND]}`, tempids);
		}

		return eid;
	}

	private resolveValue(value: unknown, tempids: Map<string, number>): unknown {
		if (isTemp(value)) {
			throw new Error('temp() can only be used as an entity id or wrapped in ref()');
		}

		if (!isRef(value)) {
			return value;
		}

		const target = value[REF_BRAND];
		if (isTemp(target)) {
			return ref(this.tempidId(`t:${target[TEMP_BRAND]}`, tempids));
		}

		if (typeof target === 'number' && target < 0) {
			return ref(this.tempidId(`n:${target}`, tempids));
		}

		return value;
	}

	private tempidId(key: string, tempids: Map<string, number>): number {
		const existing = tempids.get(key);
		if (existing !== undefined) {
			return existing;
		}

		while (this.eavt.has(this.nextEntityEid)) {
			this.nextEntityEid += 1;
		}

		const id = this.nextEntityEid;
		this.nextEntityEid += 1;
		tempids.set(key, id);
		return id;
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
			cardinality: schema.cardinality,
			unique: schema.unique,
			ref: schema.ref
		};
	}

	getSchemas(): SchemaInfo[] {
		return [...this.attributeSchemas.values()]
			.map((schema) => ({
				eid: schema.eid,
				ident: schema.ident,
				valueType: schema.valueType,
				cardinality: schema.cardinality,
				unique: schema.unique,
				ref: schema.ref
			}))
			.sort((left, right) => left.ident.localeCompare(right.ident));
	}

	entity(eid: EntityId, tx?: number): EntityState | null {
		const txLimit = normalizeTxLimit(tx);
		const entityAttributes = this.eavt.get(eid);
		if (!entityAttributes) {
			return null;
		}

		const state = new Map<string, unknown>();

		for (const [attribute, facts] of entityAttributes) {
			for (const [, , value, factTx, op] of facts) {
				if (factTx > txLimit) {
					continue;
				}

				const schema = this.attributeSchemas.get(attribute);
				if (schema?.cardinality === 'many') {
					const current = state.get(attribute);
					const values = current instanceof Map ? current : new Map<string, unknown>();

					if (op === 'add') {
						values.set(valueKey(value), value);
					} else {
						values.delete(valueKey(value));
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
		}

		if (state.size === 0) {
			return null;
		}

		const entity: EntityState = { id: eid };
		for (const [attribute, value] of state) {
			entity[attribute] = value instanceof Map ? Object.freeze(Array.from(value.values())) : value;
		}

		return Object.freeze(entity);
	}

	find(criteria: Record<string, unknown>, tx?: number): EntityState[] {
		const txLimit = normalizeTxLimit(tx);
		const matches: EntityState[] = [];

		for (const eid of this.candidateEidsForCriteria(criteria, txLimit)) {
			const entity = this.entity(eid, txLimit);
			if (!entity) {
				continue;
			}

			const doesMatch = Object.entries(criteria).every(([key, value]) => sameValue(entity[key], value));
			if (doesMatch) {
				matches.push(entity);
			}
		}

		return matches;
	}

	/**
	 * Returns candidate entity ids (in global first-fact order) that could match the
	 * criteria, narrowed through the AVET/AEVT indexes. Correctness still comes from
	 * the full entity check in `find`; this only avoids scanning every fact.
	 */
	private candidateEidsForCriteria(criteria: Record<string, unknown>, txLimit: number): EntityId[] {
		const entries = Object.entries(criteria);
		if (entries.length === 0) {
			return [...this.eavt.keys()];
		}

		const sets: Array<Set<EntityId>> = [];
		for (const [key, value] of entries) {
			const eids = new Set<EntityId>();

			if (key === 'id') {
				if (typeof value === 'number' || typeof value === 'string') {
					eids.add(value);
				}
				sets.push(eids);
				continue;
			}

			const valueFacts = this.avet.get(key)?.get(valueKey(value));
			if (valueFacts) {
				for (const fact of valueFacts) {
					if (fact[3] <= txLimit) {
						eids.add(fact[0]);
					}
				}
			}
			sets.push(eids);
		}

		const ordered: EntityId[] = [];
		for (const eid of this.eavt.keys()) {
			if (sets.every((set) => set.has(eid))) {
				ordered.push(eid);
			}
		}

		return ordered;
	}

	query(spec: QuerySpec, tx?: number): QueryTerm[][] {
		const txLimit = normalizeTxLimit(tx);
		const where = spec.where;

		// Assign a positional column to every variable in first-appearance order.
		// Bindings are rows (QueryTerm[]) aligned to these columns instead of
		// Record<string, QueryTerm> objects: binding a variable is an array write
		// and lookups are integer indexes, so no per-row object spread or property
		// hashing happens in the join loop.
		const columns = new Map<string, number>();
		for (const [entityTerm, , valueTerm] of where) {
			if (isVariable(entityTerm) && !columns.has(entityTerm)) {
				columns.set(entityTerm, columns.size);
			}

			if (isVariable(valueTerm) && !columns.has(valueTerm)) {
				columns.set(valueTerm, columns.size);
			}
		}

		let bindings: QueryTerm[][] = [[]];

		if (where.length > 0) {
			const candidates = this.candidateEidsForQuery(where, txLimit);
			const candidateSet = new Set(candidates);

			for (const [entityTerm, attribute, valueTerm] of where) {
				if (bindings.length === 0) {
					break;
				}

				const entityVar = isVariable(entityTerm) ? entityTerm : null;
				const valueVar = isVariable(valueTerm) ? valueTerm : null;
				const eCol = entityVar === null ? -1 : (columns.get(entityVar) as number);
				const vCol = valueVar === null ? -1 : (columns.get(valueVar) as number);
				const nextBindings: QueryTerm[][] = [];

				// Constant entity term: the clause either filters every binding or
				// expands the single entity's values into the value variable.
				if (entityVar === null) {
					const termEid =
						typeof entityTerm === 'number' || typeof entityTerm === 'string' ? entityTerm : null;
					if (termEid === null || !candidateSet.has(termEid)) {
						bindings = [];
						break;
					}

					if (valueVar === null) {
						if (this.hasAttributeValue(termEid, attribute, valueTerm, txLimit)) {
							for (const binding of bindings) {
								nextBindings.push(binding);
							}
						}
					} else {
						for (const binding of bindings) {
							for (const item of this.attributeValues(termEid, attribute, txLimit)) {
								if (!isQueryTerm(item)) {
									continue;
								}

								const extended = this.extendBinding(binding, vCol, item);
								if (extended !== null) {
									nextBindings.push(extended);
								}
							}
						}
					}

					bindings = nextBindings;
					continue;
				}

				// Entity variable already bound: consult the EAVT index directly per
				// binding instead of materializing (eid, value) triples for every
				// candidate and grouping them. This is the hot path for joins and is
				// O(bindings × values-per-entity) rather than O(candidates) per clause.
				if (bindings[0][eCol] !== undefined) {
					if (valueVar === null) {
						for (const binding of bindings) {
							if (this.hasAttributeValue(binding[eCol] as EntityId, attribute, valueTerm, txLimit)) {
								nextBindings.push(binding);
							}
						}
					} else if (vCol === eCol) {
						for (const binding of bindings) {
							for (const item of this.attributeValues(binding[eCol] as EntityId, attribute, txLimit)) {
								if (!isQueryTerm(item)) {
									continue;
								}

								if (Object.is(binding[eCol], item)) {
									nextBindings.push(binding);
								}
							}
						}
					} else if (bindings[0][vCol] !== undefined) {
						for (const binding of bindings) {
							if (this.hasAttributeValue(binding[eCol] as EntityId, attribute, binding[vCol] as QueryTerm, txLimit)) {
								nextBindings.push(binding);
							}
						}
					} else {
						for (const binding of bindings) {
							for (const item of this.attributeValues(binding[eCol] as EntityId, attribute, txLimit)) {
								if (!isQueryTerm(item)) {
									continue;
								}

								const extended = this.extendBinding(binding, vCol, item);
								if (extended !== null) {
									nextBindings.push(extended);
								}
							}
						}
					}

					bindings = nextBindings;
					continue;
				}

				// Entity variable unbound: iterate the ordered candidate list (global
				// first-fact order) and expand/verify each candidate's values. This
				// preserves the full-scan row ordering exactly.
				if (valueVar === null) {
					for (const binding of bindings) {
						for (const eid of candidates) {
							if (this.hasAttributeValue(eid, attribute, valueTerm, txLimit)) {
								const extended = this.extendBinding(binding, eCol, eid);
								if (extended !== null) {
									nextBindings.push(extended);
								}
							}
						}
					}
				} else if (vCol === eCol) {
					for (const binding of bindings) {
						for (const eid of candidates) {
							for (const item of this.attributeValues(eid, attribute, txLimit)) {
								if (!isQueryTerm(item)) {
									continue;
								}

								if (Object.is(eid, item)) {
									const extended = this.extendBinding(binding, eCol, eid);
									if (extended !== null) {
										nextBindings.push(extended);
									}
								}
							}
						}
					}
				} else {
					for (const binding of bindings) {
						for (const eid of candidates) {
							for (const item of this.attributeValues(eid, attribute, txLimit)) {
								if (!isQueryTerm(item)) {
									continue;
								}

								const extended = this.extendBinding(binding, eCol, eid);
								if (extended === null) {
									continue;
								}

								const withValue = this.extendBinding(extended, vCol, item);
								if (withValue !== null) {
									nextBindings.push(withValue);
								}
							}
						}
					}
				}

				bindings = nextBindings;
			}
		}

		const seen = new Set<string>();
		const rows: QueryTerm[][] = [];
		for (const binding of bindings) {
			const row = spec.find.map((term) => {
				if (!isVariable(term)) {
					return term as QueryTerm;
				}

				const col = columns.get(term);
				return col === undefined ? null : (binding[col] ?? null);
			});

			const key = rowKey(row);
			if (seen.has(key)) {
				continue;
			}

			seen.add(key);
			rows.push(row);
		}

		return rows;
	}

	/**
	 * Extends a positional binding row with `value` at `col`, returning null when
	 * the column is already bound to a different value (mirrors the old
	 * bindTerm consistency check without allocating an object per bind).
	 */
	private extendBinding(binding: QueryTerm[], col: number, value: QueryTerm): QueryTerm[] | null {
		const existing = binding[col];
		if (existing !== undefined && !Object.is(existing, value)) {
			return null;
		}

		const extended = binding.slice();
		extended[col] = value;
		return extended;
	}

	/**
	 * True when the entity's active value(s) for `attribute` as of `txLimit`
	 * include `value`. Cardinality-many matching uses the canonical value key
	 * (consistent with state reconstruction); everything else keeps Object.is
	 * semantics. Mirrors attributeValues + clauseTriples' constant filter
	 * without allocating.
	 */
	private hasAttributeValue(eid: EntityId, attribute: string, value: QueryTerm, txLimit: number): boolean {
		const facts = this.eavt.get(eid)?.get(attribute);
		if (!facts) {
			return false;
		}

		const schema = this.attributeSchemas.get(attribute);
		if (schema?.cardinality === 'many') {
			let present = false;
			for (const [, , factValue, factTx, op] of facts) {
				if (factTx > txLimit) {
					continue;
				}

				const matches = sameValue(factValue, value);
				if (op === 'add') {
					if (matches) {
						present = true;
					}
				} else if (matches) {
					present = false;
				}
			}

			return present;
		}

		let current: unknown;
		for (const [, , factValue, factTx, op] of facts) {
			if (factTx > txLimit) {
				continue;
			}

			if (op === 'add') {
				current = factValue;
			} else if (current !== undefined && Object.is(current, factValue)) {
				current = undefined;
			}
		}

		return isQueryTerm(current) && Object.is(current, value);
	}

	/**
	 * Returns entity ids (in global first-fact order) that satisfy every clause's
	 * attribute/value constraint, narrowed via the AVET/AEVT indexes instead of
	 * scanning every fact. Any entity that can contribute to a result row is a
	 * member of every per-clause set, so restricting to this intersection never
	 * drops a result (and preserves the full-scan row ordering).
	 */
	private candidateEidsForQuery(where: QueryClause[], txLimit: number): EntityId[] {
		const sets: Array<Set<EntityId>> = [];
		for (const [, attribute, valueTerm] of where) {
			const eids = new Set<EntityId>();

			if (!isVariable(valueTerm)) {
				const valueFacts = this.avet.get(attribute)?.get(valueKey(valueTerm));
				if (valueFacts) {
					for (const fact of valueFacts) {
						if (fact[3] <= txLimit) {
							eids.add(fact[0]);
						}
					}
				}
				sets.push(eids);
				continue;
			}

			const attributeEntities = this.aevt.get(attribute);
			if (attributeEntities) {
				for (const [eid, facts] of attributeEntities) {
					for (const fact of facts) {
						if (fact[3] <= txLimit) {
							eids.add(eid);
							break;
						}
					}
				}
			}
			sets.push(eids);
		}

		const ordered: EntityId[] = [];
		for (const eid of this.eavt.keys()) {
			if (sets.every((set) => set.has(eid))) {
				ordered.push(eid);
			}
		}

		return ordered;
	}

	/**
	 * Extracts the active value(s) of one attribute for an entity as of a
	 * transaction limit, straight from the EAVT index. Mirrors the entity-state
	 * reconstruction for a single attribute: cardinality-many returns the values
	 * in insertion order (re-adds move to the end), anything else is last-wins.
	 */
	private attributeValues(eid: EntityId, attribute: string, txLimit: number): unknown[] {
		const facts = this.eavt.get(eid)?.get(attribute);
		if (!facts) {
			return [];
		}

		const schema = this.attributeSchemas.get(attribute);
		if (schema?.cardinality === 'many') {
			const values = new Map<string, unknown>();
			for (const [, , value, factTx, op] of facts) {
				if (factTx > txLimit) {
					continue;
				}

				if (op === 'add') {
					values.set(valueKey(value), value);
				} else {
					values.delete(valueKey(value));
				}
			}
			return Array.from(values.values());
		}

		let current: unknown;
		for (const [, , value, factTx, op] of facts) {
			if (factTx > txLimit) {
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

	private schemaDeclarationToFacts(schema: SchemaDeclaration): Mutation[] {
		const existingSchema = this.attributeSchemas.get(schema.ident);
		if (existingSchema) {
			if (existingSchema.valueType !== schema.valueType || existingSchema.cardinality !== schema.cardinality) {
				throw new Error(`Schema conflict for ${schema.ident}`);
			}

			if (
				schema.unique !== undefined &&
				existingSchema.unique !== undefined &&
				schema.unique !== existingSchema.unique
			) {
				throw new Error(`Schema conflict for ${schema.ident}: unique constraint mismatch`);
			}

			if (schema.ref !== undefined && existingSchema.ref !== undefined && schema.ref !== existingSchema.ref) {
				throw new Error(`Schema conflict for ${schema.ident}: ref mismatch`);
			}

			// Re-declaration: append only the schema facts that actually change.
			const facts: Mutation[] = [];
			if (schema.unique !== undefined && existingSchema.unique !== schema.unique) {
				facts.push(['add', existingSchema.eid, 'db/unique', schema.unique]);
			}
			if (schema.ref !== undefined && existingSchema.ref !== schema.ref) {
				facts.push(['add', existingSchema.eid, 'db/ref', schema.ref]);
			}
			return facts;
		}

		const schemaEid = this.nextSchemaEid--;
		const facts: Mutation[] = [
			['add', schemaEid, 'db/ident', schema.ident],
			['add', schemaEid, 'db/valueType', schema.valueType],
			['add', schemaEid, 'db/cardinality', schema.cardinality]
		];
		if (schema.unique !== undefined) {
			facts.push(['add', schemaEid, 'db/unique', schema.unique]);
		}
		if (schema.ref !== undefined) {
			facts.push(['add', schemaEid, 'db/ref', schema.ref]);
		}
		return facts;
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

		if (attribute === 'db/unique' && (value === 'identity' || value === 'value')) {
			schema.unique = value;
		}

		if (attribute === 'db/ref' && typeof value === 'boolean') {
			schema.ref = value;
		}
	}

	private validateMutations(mutations: Mutation[]): void {
		const manyState = new Map<string, Map<string, unknown>>();
		const oneState = new Map<string, unknown>();
		const uniqueState = new Map<string, Map<string, Set<EntityId>>>();

		for (const [op, eid, attribute, value] of mutations) {
			// Value-level rules apply to every write, schema or not: no opaque
			// objects, no NaN / ±Infinity, no invalid Dates.
			assertSupportedValue(value, attribute);

			const schema = this.attributeSchemas.get(attribute);
			if (!schema) {
				continue;
			}

			if (!matchesValueType(value, schema.valueType)) {
				throw new Error(`Invalid value type for ${attribute}. Expected ${schema.valueType}`);
			}

			if ((schema.ref === true || schema.valueType === 'ref') && !isRef(value) && !isLookupRef(value)) {
				throw new Error(`Invalid value for ${attribute}: expected a ref() or lookupRef() value`);
			}

			if (schema.unique === 'value') {
				this.enforceUniqueValue(attribute, eid, value, op, uniqueState);
			}

			const key = `${eid}:${attribute}`;
			if (schema.cardinality === 'many') {
				const current =
					manyState.get(key) ??
					new Map(this.activeValues(eid, attribute).map((v) => [valueKey(v), v] as const));
				if (op === 'add') {
					current.set(valueKey(value), value);
				} else {
					current.delete(valueKey(value));
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

	/**
	 * Enforces `db/unique: 'value'`: the value may be active on at most one
	 * entity. Same-entity re-adds are allowed (they are no-ops); the holder set
	 * is tracked across the transaction so duplicates within one tx are caught.
	 */
	private enforceUniqueValue(
		attribute: string,
		eid: EntityId,
		value: unknown,
		op: FactOperation,
		uniqueState: Map<string, Map<string, Set<EntityId>>>
	): void {
		const holders = uniqueState.get(attribute) ?? this.activeUniqueHolders(attribute);
		const valueKeyString = valueKey(value);
		const valueHolders = holders.get(valueKeyString) ?? new Set<EntityId>();

		if (op === 'add') {
			if (valueHolders.size > 0 && !(valueHolders.size === 1 && valueHolders.has(eid))) {
				throw new Error(`Unique constraint violation for ${attribute}: value already exists`);
			}
			valueHolders.add(eid);
		} else {
			valueHolders.delete(eid);
		}

		if (valueHolders.size === 0) {
			holders.delete(valueKeyString);
		} else {
			holders.set(valueKeyString, valueHolders);
		}
		uniqueState.set(attribute, holders);
	}

	/** Active (entity, value) holders for a unique attribute across all entities. */
	private activeUniqueHolders(attribute: string): Map<string, Set<EntityId>> {
		const holders = new Map<string, Set<EntityId>>();
		const attributeEntities = this.aevt.get(attribute);
		if (!attributeEntities) {
			return holders;
		}

		for (const [eid] of attributeEntities) {
			for (const value of this.attributeValues(eid, attribute, Number.POSITIVE_INFINITY)) {
				const valueKeyString = valueKey(value);
				const valueHolders = holders.get(valueKeyString) ?? new Set<EntityId>();
				valueHolders.add(eid);
				holders.set(valueKeyString, valueHolders);
			}
		}

		return holders;
	}

	private activeValues(eid: EntityId, attribute: string): unknown[] {
		return this.attributeValues(eid, attribute, Number.POSITIVE_INFINITY);
	}
}

export function createDatabase(): FactDatabase {
	return new FactDatabase();
}
