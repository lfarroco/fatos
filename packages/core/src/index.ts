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

/**
 * A point-in-time snapshot of a database: the full append-only fact log plus
 * the transaction ledger (design/04 persistence). `restore()` consumes it to
 * rebuild a database that behaves identically to the one that saved it.
 */
export type DatabaseSnapshot = {
	facts: readonly Fact[];
	transactions: readonly TransactionRecord[];
};

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

/**
 * Mango-style find operators (design/02). Multiple keys on one object AND
 * together; for cardinality-many attributes each operator matches against any
 * member of the attribute's value set.
 */
export type FindOperator = {
	$eq?: unknown;
	$ne?: unknown;
	$gt?: unknown;
	$gte?: unknown;
	$lt?: unknown;
	$lte?: unknown;
	$in?: unknown[];
	$nin?: unknown[];
	$exists?: boolean;
	$contains?: unknown;
};

export type OrderDirection = 'asc' | 'desc';
export type OrderBy = readonly [attribute: string, direction: OrderDirection];

export type FindOptions = {
	tx?: number;
	orderBy?: OrderBy | OrderBy[];
	limit?: number;
	offset?: number;
	select?: string[];
	/** How `ref()` values read back from entity state (see {@link EntityReadOptions}). */
	refs?: 'id' | 'ref';
};

/**
 * Read options for entity-shaped reads (`entity` / `find` / the `at(tx)`
 * view), design/01: "values of ref-typed attributes may be returned as
 * `ref()` values when a flag is set (default: plain id, for ergonomics and
 * JSON compatibility)".
 */
export type EntityReadOptions = {
	/**
	 * `'id'` (default) unwraps `ref(number|string)` values to the plain entity
	 * id; `'ref'` keeps the branded `ref()` value. `lookupRef` targets always
	 * stay branded either way (unwrapping them needs the unique-index lookup).
	 */
	refs?: 'id' | 'ref';
};

/** A plain attribute map accepted by `insert`/`upsert`; `id` is optional. */
export type InsertMap = Record<string, unknown>;

/** Whitespace-separated dot-paths or an explicit string array (design/02 pull). */
export type PullPath = string | string[];

export type DiffResult = {
	added: Fact[];
	retracted: Fact[];
};

/**
 * A clause value may be a scalar term (bare value = $eq), a `find` operator
 * object, or a non-QueryTerm constant (Date / bigint / ref / lookupRef).
 */
export type QueryValueTerm = QueryTerm | FindOperator | Date | bigint | Ref | LookupRef;
export type QueryClause = readonly [entity: QueryTerm, attribute: string, value: QueryValueTerm];
export type QuerySpec = {
	find: string[];
	where: QueryClause[];
};

export type EntityState = Record<string, unknown> & { id: EntityId };

/** A live-query handle: memoized `current` value plus change subscription (design/03). */
export type LiveResult<T> = {
	readonly current: T;
	/** Registers a change callback; returns an unsubscribe function. */
	subscribe(callback: (value: T) => void): () => void;
	/** Stops tracking and notification; `current` stays readable afterwards. */
	dispose(): void;
};

/** A `liveQuery` handle: an async iterable of result snapshots plus live accessors. */
export type LiveQueryResult<T> = LiveResult<T> & AsyncIterable<T>;

export type LiveQueryOptions = {
	/** When the signal fires, delivery stops (the iterator's return()/throw() work too). */
	signal?: AbortSignal;
};

/**
 * Interned index shapes (design/05): EAVT/AEVT/AVET are keyed by internal numeric
 * attribute ids instead of ident strings, so hot lookups hash SMIs and each distinct
 * attribute ident is stored once. Entity keys stay user-facing `EntityId`s (numbers or
 * canonicalized strings); only the attribute level is interned in Phase 1.
 */
type EAVTIndex = Map<EntityId, Map<number, Fact[]>>;
type AEVTIndex = Map<number, Map<EntityId, Fact[]>>;
type AVETIndex = Map<number, Map<string, Fact[]>>;

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
 * Applies the `refs` read option (design/01) to one stored value: in `'id'`
 * mode (default) a `ref(number|string)` unwraps to the plain entity id;
 * `ref(lookupRef(...))` and bare `lookupRef(...)` stay branded (resolving
 * them needs the unique-index lookup, which `pull` does separately).
 */
function unwrapRefValue(value: unknown, refs: 'id' | 'ref'): unknown {
	if (refs === 'ref') {
		return value;
	}

	if (isRef(value)) {
		const target = value[REF_BRAND];
		if (typeof target === 'number' || typeof target === 'string') {
			return target;
		}
	}

	return value;
}

/**
 * P3 wire protocol (design/03): JSON type tags for values that plain JSON
 * cannot represent losslessly. Facts keep their 5-tuple shape on the wire;
 * only the value slot is tagged.
 *
 * | JS                          | JSON                                      |
 * |-----------------------------|-------------------------------------------|
 * | `ref(id)`                   | `{ "$ref": id }`                          |
 * | `ref(lookupRef([a, v]))`    | `{ "$ref": { "$lookupRef": [a, v] } }`    |
 * | `lookupRef([a, v])`         | `{ "$lookupRef": [a, v] }`                |
 * | `Date`                      | `{ "$date": ms }`                         |
 * | `BigInt`                    | `{ "$bigint": "..." }`                    |
 * | everything else             | plain JSON                                |
 */
export type WireTaggedValue =
	| { readonly $ref: EntityId | { readonly $lookupRef: readonly [string, ScalarValue] } }
	| { readonly $lookupRef: readonly [string, ScalarValue] }
	| { readonly $date: number }
	| { readonly $bigint: string };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Serializes a stored value into its JSON-wire form (design/03). */
export function serializeValue(value: unknown): unknown {
	if (isRef(value)) {
		const target = value[REF_BRAND];
		if (isTemp(target)) {
			throw new Error('temp() handles cannot be serialized; resolve them before commit');
		}

		return { $ref: serializeValue(target) };
	}

	if (isLookupRef(value)) {
		const [attribute, scalar] = value[LOOKUP_REF_BRAND];
		return { $lookupRef: [attribute, scalar] };
	}

	if (value instanceof Date) {
		return { $date: value.getTime() };
	}

	if (typeof value === 'bigint') {
		return { $bigint: value.toString() };
	}

	if (Array.isArray(value)) {
		return value.map((item) => serializeValue(item));
	}

	if (isTemp(value)) {
		throw new Error('temp() handles cannot be serialized; resolve them before commit');
	}

	return value;
}

/** Inverse of {@link serializeValue}: parses a JSON-wire value back into engine values. */
export function deserializeValue(json: unknown): unknown {
	if (Array.isArray(json)) {
		return json.map((item) => deserializeValue(item));
	}

	if (!isPlainRecord(json)) {
		return json;
	}

	if (typeof json.$date === 'number' && Number.isFinite(json.$date)) {
		return new Date(json.$date);
	}

	if (typeof json.$bigint === 'string') {
		return BigInt(json.$bigint);
	}

	if ('$ref' in json) {
		const target = json.$ref;
		if (typeof target === 'number' || typeof target === 'string') {
			return ref(target);
		}

		if (isPlainRecord(target) && Array.isArray(target.$lookupRef)) {
			const pair = target.$lookupRef;
			if (typeof pair[0] === 'string' && isScalarValue(pair[1])) {
				return ref(lookupRef([pair[0], pair[1]]));
			}
		}

		throw new Error('Invalid $ref wire value');
	}

	if ('$lookupRef' in json) {
		const pair = json.$lookupRef;
		if (Array.isArray(pair) && typeof pair[0] === 'string' && isScalarValue(pair[1])) {
			return lookupRef([pair[0], pair[1]]);
		}

		throw new Error('Invalid $lookupRef wire value');
	}

	return json;
}

/**
 * Deserializes a wire-form QuerySpec (design/03): `where` value terms may
 * carry `$date`/`$bigint`/`$ref`/`$lookupRef` tags, and find-operator values
 * (`$eq`, `$in`, ...) are deserialized recursively.
 */
export function deserializeQuerySpec(json: unknown): QuerySpec {
	if (!isPlainRecord(json) || !Array.isArray(json.find) || !Array.isArray(json.where)) {
		throw new Error('Invalid QuerySpec: expected { find: string[], where: QueryClause[] }');
	}

	const find = json.find.map((item) => {
		if (typeof item !== 'string') {
			throw new Error('Invalid QuerySpec: find entries must be strings');
		}

		return item;
	});

	const where: QueryClause[] = json.where.map((clause) => {
		if (
			!Array.isArray(clause) ||
			clause.length < 3 ||
			!isQueryTerm(clause[0]) ||
			typeof clause[1] !== 'string'
		) {
			throw new Error('Invalid QuerySpec: where clauses must be [entity, attribute, value] triples');
		}

		return [clause[0], clause[1], deserializeQueryValue(clause[2])] as const;
	});

	return { find, where };
}

function deserializeQueryValue(json: unknown): QueryValueTerm {
	if (isPlainRecord(json)) {
		const keys = Object.keys(json);
		const isTagged = keys.some(
			(key) => key === '$ref' || key === '$lookupRef' || key === '$date' || key === '$bigint'
		);
		if (isTagged) {
			return deserializeValue(json) as QueryValueTerm;
		}

		// Find-operator object: every key starts with '$'.
		if (keys.length > 0 && keys.every((key) => key.startsWith('$'))) {
			const operator: Record<string, unknown> = {};
			for (const key of keys) {
				operator[key] = deserializeValue(json[key]);
			}

			return operator as FindOperator;
		}
	}

	return deserializeValue(json) as QueryValueTerm;
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
 * Recursive JSON-stable key for live-result memoization and diffing. Unlike
 * JSON.stringify this handles every value the engine stores (Date by ms
 * epoch, BigInt by its string form, ref/lookupRef by target, cardinality-many
 * arrays) and sorts plain-object keys so identical content keys identically
 * regardless of insertion order.
 */
function stableValueKey(value: unknown): string {
	if (value === null) {
		return 'null';
	}

	if (typeof value === 'string') {
		return JSON.stringify(value);
	}

	if (typeof value === 'number') {
		return Object.is(value, -0) ? '0' : Number.isFinite(value) ? String(value) : 'null';
	}

	if (typeof value === 'boolean') {
		return value ? 'true' : 'false';
	}

	if (typeof value === 'undefined') {
		return 'undefined';
	}

	if (typeof value === 'bigint') {
		return `bigint:${value.toString()}`;
	}

	if (typeof value === 'symbol') {
		return 'symbol';
	}

	if (value instanceof Date) {
		return `date:${value.getTime()}`;
	}

	if (isRef(value)) {
		return `ref:${stableValueKey(value[REF_BRAND])}`;
	}

	if (isLookupRef(value)) {
		return `lookupRef:${value[LOOKUP_REF_BRAND].map(stableValueKey).join(':')}`;
	}

	if (Array.isArray(value)) {
		let key = '[';
		for (let i = 0; i < value.length; i += 1) {
			if (i > 0) {
				key += ',';
			}
			key += stableValueKey(value[i]);
		}
		return `${key}]`;
	}

	if (typeof value === 'object') {
		const entries = Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableValueKey((value as Record<string, unknown>)[key])}`);
		return `{${entries.join(',')}}`;
	}

	return `${typeof value}:${String(value)}`;
}

const FIND_OPERATOR_KEYS = new Set([
	'$eq',
	'$ne',
	'$gt',
	'$gte',
	'$lt',
	'$lte',
	'$in',
	'$nin',
	'$exists',
	'$contains'
]);

/**
 * True when `value` is a find-operator object. Plain objects with non-operator
 * keys are rejected — opaque objects are not values (design/01).
 */
function isFindOperator(value: unknown): value is FindOperator {
	if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof Date) {
		return false;
	}

	if (isRef(value) || isTemp(value) || isLookupRef(value)) {
		return false;
	}

	const keys = Object.keys(value);
	if (keys.length === 0) {
		return false;
	}

	for (const key of keys) {
		if (!FIND_OPERATOR_KEYS.has(key)) {
			throw new Error(`Unknown find operator "${key}" in criteria ${JSON.stringify(value)}`);
		}
	}

	return true;
}

/** Total deterministic rank used by comparison operators and orderBy. */
function valueRank(value: unknown): number {
	if (value === undefined) {
		return -1;
	}

	if (value === null) {
		return 0;
	}

	if (typeof value === 'boolean') {
		return 1;
	}

	if (typeof value === 'number') {
		return 2;
	}

	if (typeof value === 'string') {
		return 3;
	}

	if (value instanceof Date) {
		return 4;
	}

	if (typeof value === 'bigint') {
		return 5;
	}

	if (isRef(value) || isLookupRef(value)) {
		return 6;
	}

	return 7;
}

/**
 * Total order over supported values (null < boolean < number < string <
 * Date < bigint < ref), used by $gt/$gte/$lt/$lte and orderBy. Returns null
 * for values outside the supported model (never committed by the engine).
 */
function compareValues(left: unknown, right: unknown): number | null {
	if ((typeof left === 'number' && Number.isNaN(left)) || (typeof right === 'number' && Number.isNaN(right))) {
		return null;
	}

	const leftRank = valueRank(left);
	const rightRank = valueRank(right);
	if (leftRank !== rightRank) {
		return leftRank < rightRank ? -1 : 1;
	}

	switch (leftRank) {
		case -1:
		case 0:
			return 0;
		case 1:
			return left === right ? 0 : left ? 1 : -1;
		case 2:
			return (left as number) < (right as number) ? -1 : (left as number) > (right as number) ? 1 : 0;
		case 3:
			return (left as string) < (right as string) ? -1 : (left as string) > (right as string) ? 1 : 0;
		case 4:
			return (left as Date).getTime() < (right as Date).getTime()
				? -1
				: (left as Date).getTime() > (right as Date).getTime()
					? 1
					: 0;
		case 5:
			return (left as bigint) < (right as bigint) ? -1 : (left as bigint) > (right as bigint) ? 1 : 0;
		case 6:
			return refTargetKey((left as Ref)[REF_BRAND]) < refTargetKey((right as Ref)[REF_BRAND])
				? -1
				: refTargetKey((left as Ref)[REF_BRAND]) > refTargetKey((right as Ref)[REF_BRAND])
					? 1
					: 0;
		default:
			return null;
	}
}

/**
 * Evaluates one criterion against the attribute's active values. Bare values
 * are $eq; operators match if ANY member satisfies them (cardinality-many
 * aware, fixing the P0 array-find limitation).
 */
function criterionMatchesValue(values: unknown[], criterion: unknown): boolean {
	if (isFindOperator(criterion)) {
		return Object.entries(criterion).every(([op, operand]) => operatorMatchesValue(values, op, operand));
	}

	return values.some((value) => sameValue(value, criterion));
}

function operatorMatchesValue(values: unknown[], op: string, operand: unknown): boolean {
	switch (op) {
		case '$eq':
			return values.some((value) => sameValue(value, operand));
		case '$ne':
			return values.some((value) => !sameValue(value, operand));
		case '$gt':
			return values.some((value) => {
				const cmp = compareValues(value, operand);
				return cmp !== null && cmp > 0;
			});
		case '$gte':
			return values.some((value) => {
				const cmp = compareValues(value, operand);
				return cmp !== null && cmp >= 0;
			});
		case '$lt':
			return values.some((value) => {
				const cmp = compareValues(value, operand);
				return cmp !== null && cmp < 0;
			});
		case '$lte':
			return values.some((value) => {
				const cmp = compareValues(value, operand);
				return cmp !== null && cmp <= 0;
			});
		case '$in':
			return (
				Array.isArray(operand) &&
				values.some((value) => operand.some((item) => sameValue(value, item)))
			);
		case '$nin':
			return (
				Array.isArray(operand) &&
				values.some((value) => !operand.some((item) => sameValue(value, item)))
			);
		case '$exists':
			return operand ? values.length > 0 : values.length === 0;
		case '$contains':
			return values.some((value) => sameValue(value, operand));
		default:
			throw new Error(`Unknown find operator: ${op}`);
	}
}

/** orderBy comparison: a missing attribute sorts before every present value. */
function compareOrderValues(left: unknown, right: unknown): number {
	const cmp = compareValues(left === undefined ? null : left, right === undefined ? null : right);
	return cmp === null ? 0 : cmp;
}

/** A plain object literal usable as a nested entity map (not Date/ref/temp/lookupRef). */
function isPlainObjectValue(value: unknown): value is InsertMap {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		!(value instanceof Date) &&
		!isRef(value) &&
		!isTemp(value) &&
		!isLookupRef(value)
	);
}

/**
 * Nested entity maps must be non-empty and must not smuggle scalar wire forms
 * or operator objects through as entities (design/01: opaque scalars-as-objects
 * are rejected).
 */
function assertNestedMapUsable(map: InsertMap, attribute: string): void {
	if (Object.keys(map).length === 0) {
		throw new Error(
			`Invalid value for ${attribute}: empty objects are not supported (use ref()/lookupRef() for references)`
		);
	}

	for (const key of Object.keys(map)) {
		if (key.startsWith('$')) {
			throw new Error(
				`Invalid value for ${attribute}: "${key}" objects are not supported as values (nested entities use plain attribute maps)`
			);
		}
	}
}

function mergePullFragments(target: Record<string, unknown>, fragment: Record<string, unknown>): void {
	for (const [key, value] of Object.entries(fragment)) {
		const existing = target[key];
		if (existing === undefined) {
			target[key] = value;
			continue;
		}

		if (isPlainObjectValue(existing) && isPlainObjectValue(value)) {
			mergePullFragments(existing, value);
			continue;
		}

		if (Array.isArray(existing) && Array.isArray(value)) {
			const existingValues = existing as unknown[];
			const newValues = value as unknown[];
			if (existingValues.length === newValues.length) {
				for (let i = 0; i < existingValues.length; i += 1) {
					const left = existingValues[i];
					const right = newValues[i];
					if (isPlainObjectValue(left) && isPlainObjectValue(right)) {
						mergePullFragments(left, right);
					} else {
						existingValues[i] = right;
					}
				}
			} else {
				target[key] = newValues;
			}
			continue;
		}

		target[key] = value;
	}
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

function isVariable(term: unknown): term is string {
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

function isQuerySpec(value: unknown): value is QuerySpec {
	return (
		typeof value === 'object' &&
		value !== null &&
		'where' in value &&
		'find' in value
	);
}

/** Array.isArray guard that also narrows readonly string[] out of unions. */
function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value);
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

/**
 * Recorded attribute reads while an access-tracking `live(fn)` selector runs.
 * `attributes` holds every attribute touched (via entity proxies and via the
 * criteria/where clauses of `find`/`query`); `eidsByAttribute` records the
 * entities each attribute was actually read on.
 */
type AccessTracker = {
	/** Internal attribute ids touched while the selector ran (design/05). */
	attributes: Set<number>;
	/** Internal attribute id -> entities the attribute was actually read on. */
	eidsByAttribute: Map<number, Set<EntityId>>;
};

/**
 * Internal state of one `live`/`liveQuery` instance, owned by FactDatabase so
 * the notification path can consult the private indexes directly.
 */
type LiveHandle<T> = {
	read: () => T;
	trackReads: boolean;
	explicitDeps: ReadonlySet<number> | null;
	/** internal attribute id -> candidate eids (AEVT members at last evaluation + tracked reads). */
	dependencies: Map<number, Set<EntityId>>;
	/** No attributes were recorded — every write is potentially relevant. */
	fallbackAll: boolean;
	listeners: Set<(value: T) => void>;
	memoKey: string | null;
	memoValue: T | null;
	hasValue: boolean;
	disposed: boolean;
};

/** Disambiguated (eid, attribute) pair key for new-pair detection. */
function livePairKey(eid: EntityId, attribute: string): string {
	return `${typeof eid}:${String(eid)}\u0000${attribute}`;
}

/**
 * Validates a snapshot's ordering invariants before restore: facts must be
 * ordered by ascending tx, transaction records must be strictly ascending, and
 * the two tx sets must match exactly (every transaction has facts, every fact
 * belongs to a recorded transaction).
 */
function validateSnapshotOrder(facts: readonly Fact[], transactions: readonly TransactionRecord[]): void {
	let previousTx = 0;
	const factTxs = new Set<number>();
	for (const fact of facts) {
		const tx = fact[3];
		if (!Number.isInteger(tx) || tx < 1) {
			throw new Error(`restore(): fact tx must be a positive integer, got ${String(tx)}`);
		}
		if (tx < previousTx) {
			throw new Error('restore(): facts must be ordered by ascending tx');
		}
		previousTx = tx;
		factTxs.add(tx);
	}

	let expectedTx = 0;
	const transactionTxs = new Set<number>();
	for (const [tx] of transactions) {
		if (!Number.isInteger(tx) || tx < 1) {
			throw new Error(`restore(): transaction tx must be a positive integer, got ${String(tx)}`);
		}
		if (tx <= expectedTx) {
			throw new Error('restore(): transactions must be ordered by strictly ascending tx');
		}
		expectedTx = tx;
		transactionTxs.add(tx);
	}

	for (const tx of factTxs) {
		if (!transactionTxs.has(tx)) {
			throw new Error(`restore(): fact references tx ${tx} with no matching transaction record`);
		}
	}
	for (const tx of transactionTxs) {
		if (!factTxs.has(tx)) {
			throw new Error(`restore(): transaction ${tx} has no facts`);
		}
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
	/** attribute id -> valueKey -> holder entity ids, maintained at commit (design/04 unique-index optimization). */
	private uniqueIndex = new Map<number, Map<string, Set<EntityId>>>();
	/**
	 * Internal symbol table (design/05): every distinct attribute ident is assigned a
	 * small numeric id used as the key in EAVT/AEVT/AVET, uniqueIndex, and the live
	 * dependency maps. The id space is internal-only — ids are never exposed, and id
	 * assignment order has no observable effect (index entry order comes from first-write
	 * order, never from interner order). `attributeIds`'s map keys double as the
	 * canonical ident instances.
	 */
	private attributeIds = new Map<string, number>();
	private attributeIdents = new Map<number, string>();
	private nextAttributeId = 1;
	/** Content -> canonical instance for string entity ids (dedups equal strings). */
	private canonicalStrings = new Map<string, string>();
	/** Active access tracker while a `live(fn)` selector runs; null outside live evaluation. */
	private tracking: AccessTracker | null = null;
	/** Every live/liveQuery instance, consulted once per committed transaction. */
	private liveInstances = new Set<LiveHandle<unknown>>();

	/** Allocates (or returns) the internal id for an attribute ident. */
	private internAttribute(ident: string): number {
		const existing = this.attributeIds.get(ident);
		if (existing !== undefined) {
			return existing;
		}

		const id = this.nextAttributeId++;
		this.attributeIds.set(ident, id);
		this.attributeIdents.set(id, ident);
		return id;
	}

	/** Canonical instance for a string, deduping equal content however it arrives. */
	private canonicalString(value: string): string {
		const existing = this.canonicalStrings.get(value);
		if (existing !== undefined) {
			return existing;
		}

		this.canonicalStrings.set(value, value);
		return value;
	}

	/** Canonical user-facing eid: numbers pass through, strings are deduped. */
	private canonicalEid(eid: EntityId): EntityId {
		return typeof eid === 'string' ? this.canonicalString(eid) : eid;
	}

	private commitTransaction(metadata?: Record<string, unknown>): TransactionRecord {
		const tx = this.nextTx++;
		const timestamp = Date.now();
		const transaction: TransactionRecord = [tx, timestamp, metadata ?? null];
		this.transactions.push(transaction);
		return transaction;
	}

	private appendFact(tx: number, op: FactOperation, eid: EntityId, attribute: string, value: unknown): Fact {
		// Canonicalize the user-facing eid/attribute so equal content shares one string
		// instance, and intern the attribute to a numeric key for the indexes.
		const canonEid = this.canonicalEid(eid);
		const attrId = this.internAttribute(attribute);
		const canonAttribute = this.attributeIdents.get(attrId) as string;
		const fact: Fact = [canonEid, canonAttribute, value, tx, op];
		this.facts.push(fact);

		const entityAttributes = this.eavt.get(canonEid) ?? new Map<number, Fact[]>();
		const eavtFacts = entityAttributes.get(attrId) ?? [];
		eavtFacts.push(fact);
		entityAttributes.set(attrId, eavtFacts);
		this.eavt.set(canonEid, entityAttributes);

		const attributeEntities = this.aevt.get(attrId) ?? new Map<EntityId, Fact[]>();
		const aevtFacts = attributeEntities.get(canonEid) ?? [];
		aevtFacts.push(fact);
		attributeEntities.set(canonEid, aevtFacts);
		this.aevt.set(attrId, attributeEntities);

		const attributeValues = this.avet.get(attrId) ?? new Map<string, Fact[]>();
		const avetKey = valueKey(value);
		const avetFacts = attributeValues.get(avetKey) ?? [];
		avetFacts.push(fact);
		attributeValues.set(avetKey, avetFacts);
		this.avet.set(attrId, attributeValues);

		this.maintainUniqueIndex(canonAttribute, attrId, value, canonEid, op);

		return fact;
	}

	/**
	 * Maintains the per-attribute unique-value index incrementally at commit.
	 * The entry is built lazily from the AEVT index on first write after the
	 * unique constraint exists (schema is data — constraints can be added to
	 * attributes with pre-existing facts), then updated in place.
	 */
	private maintainUniqueIndex(attribute: string, attrId: number, value: unknown, eid: EntityId, op: FactOperation): void {
		const schema = this.attributeSchemas.get(attribute);
		if (schema?.unique !== 'identity' && schema?.unique !== 'value') {
			return;
		}

		let holders = this.uniqueIndex.get(attrId);
		if (!holders) {
			holders = this.scanUniqueHolders(attrId);
			this.uniqueIndex.set(attrId, holders);
		}

		const key = valueKey(value);
		const valueHolders = holders.get(key) ?? new Set<EntityId>();
		if (op === 'add') {
			valueHolders.add(eid);
		} else {
			valueHolders.delete(eid);
		}

		if (valueHolders.size === 0) {
			holders.delete(key);
		} else {
			holders.set(key, valueHolders);
		}
	}

	/** Builds the full (attribute, value) -> holder map from the AEVT index. */
	private scanUniqueHolders(attrId: number): Map<string, Set<EntityId>> {
		const holders = new Map<string, Set<EntityId>>();
		const attributeEntities = this.aevt.get(attrId);
		if (!attributeEntities) {
			return holders;
		}

		const attribute = this.attributeIdents.get(attrId) as string;
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

	/**
	 * Object-map authoring (design/02): flattens nested graphs depth-first /
	 * parent-major, expands arrays into cardinality-many facts, auto-declares
	 * schema for array / nested-ref attributes, and resolves `db/unique:
	 * 'identity'` attributes to existing entities (upsert). Returns resolved
	 * entity ids aligned to the input maps.
	 */
	private insertMaps(input: InsertMap | InsertMap[]): EntityId | EntityId[] {
		const maps = Array.isArray(input) ? input : [input];
		const tempids = new Map<string, number>();
		const identityMap = new Map<string, EntityId>();
		const mutations: Mutation[] = [];
		const declared = new Map<string, SchemaDeclaration>();
		const results: EntityId[] = [];

		for (const map of maps) {
			const eid = this.insertEidForMap(map, tempids, identityMap, () =>
				this.tempidId(`insert:${tempids.size}`, tempids)
			);
			results.push(eid);
			this.flattenMap(map, eid, tempids, identityMap, mutations, declared);
		}

		const entries: TransactionEntryInput[] = [...declared.values(), ...mutations];
		if (entries.length > 0) {
			this.transact(entries);
		}

		return Array.isArray(input) ? results : results[0];
	}

	/**
	 * Resolves the entity a top-level map writes to: an explicit `id` wins;
	 * otherwise the first `db/unique: 'identity'` attribute (plain value or
	 * lookupRef) matches an existing entity, and a fresh tempid is allocated
	 * when nothing matches. Matches made earlier in the same call are reused so
	 * repeated identity values alias within one transaction.
	 */
	private insertEidForMap(
		map: InsertMap,
		tempids: Map<string, number>,
		identityMap: Map<string, EntityId>,
		allocate: () => number
	): EntityId {
		const id = map['id'];
		if (id !== undefined) {
			return this.resolveEid(id as InputEid, tempids);
		}

		let allocated: EntityId | null = null;
		for (const [attr, value] of Object.entries(map)) {
			if (attr === 'id') {
				continue;
			}

			let identityValue: unknown = value;
			if (isLookupRef(value)) {
				identityValue = value[LOOKUP_REF_BRAND][1];
			} else if (isRef(value) && isLookupRef(value[REF_BRAND])) {
				identityValue = value[REF_BRAND][LOOKUP_REF_BRAND][1];
			}

			if (this.attributeSchemas.get(attr)?.unique !== 'identity') {
				continue;
			}

			const key = `identity:${attr}:${valueKey(identityValue)}`;
			const inTransaction = identityMap.get(key);
			if (inTransaction !== undefined) {
				return inTransaction;
			}

			const existing = this.resolveIdentityTarget(attr, identityValue);
			if (existing !== null) {
				identityMap.set(key, existing);
				return existing;
			}

			if (allocated === null) {
				allocated = allocate();
			}
			identityMap.set(key, allocated);
		}

		return allocated ?? allocate();
	}

	/** Looks up the current holder of an `identity`-unique value, if any. */
	private resolveIdentityTarget(attribute: string, identityValue: unknown): EntityId | null {
		const schema = this.attributeSchemas.get(attribute);
		if (!schema || schema.unique !== 'identity') {
			return null;
		}

		const holders = this.activeUniqueHolders(attribute).get(valueKey(identityValue));
		if (!holders || holders.size === 0) {
			return null;
		}

		return [...holders][0];
	}

	/**
	 * Deterministically flattens one attribute map into mutations. Depth-first,
	 * parent-major: nested objects become entities joined via ref attributes
	 * (auto-declared `valueType: 'ref'`), arrays expand into cardinality-many
	 * facts (auto-declared cardinality many), and `ref(temp())` values resolve
	 * against the transaction's tempid map (parent/sibling references).
	 */
	private flattenMap(
		map: InsertMap,
		eid: EntityId,
		tempids: Map<string, number>,
		identityMap: Map<string, EntityId>,
		mutations: Mutation[],
		declared: Map<string, SchemaDeclaration>
	): void {
		for (const [key, value] of Object.entries(map)) {
			if (key === 'id') {
				continue;
			}

			if (Array.isArray(value)) {
				const hasObjects = value.some((item) => isPlainObjectValue(item));

				if (hasObjects) {
					this.declareSchema(declared, key, 'ref', 'many');
					for (const item of value) {
						if (!isPlainObjectValue(item)) {
							throw new Error(
								`Invalid value for ${key}: cannot mix nested objects and scalar values in one array`
							);
						}

						assertNestedMapUsable(item, key);
						const childEid = this.nestedEid(item, tempids);
						this.flattenMap(item, childEid, tempids, identityMap, mutations, declared);
						mutations.push(['add', eid, key, ref(childEid)]);
					}
					continue;
				}

				this.declareSchema(declared, key, 'unknown', 'many');
				if (value.length === 0) {
					continue;
				}

				for (const item of value) {
					mutations.push(['add', eid, key, this.resolveInsertValue(item, tempids, identityMap)]);
				}
				continue;
			}

			if (isPlainObjectValue(value)) {
				assertNestedMapUsable(value, key);
				this.declareSchema(declared, key, 'ref', 'one');
				const childEid = this.nestedEid(value, tempids);
				this.flattenMap(value, childEid, tempids, identityMap, mutations, declared);
				mutations.push(['add', eid, key, ref(childEid)]);
				continue;
			}

			mutations.push(['add', eid, key, this.resolveInsertValueForKey(key, value, tempids, identityMap)]);
		}
	}

	private nestedEid(map: InsertMap, tempids: Map<string, number>): EntityId {
		const id = map['id'];
		if (id !== undefined) {
			return this.resolveEid(id as InputEid, tempids);
		}

		return this.tempidId(`nested:${tempids.size}`, tempids);
	}

	/**
	 * Auto-declares schema for attributes the object grammar introduced. Only
	 * attributes without an existing schema are declared (existing schema
	 * governs, and its constraints surface through normal validation).
	 */
	private declareSchema(
		declared: Map<string, SchemaDeclaration>,
		ident: string,
		valueType: ValueType,
		cardinality: Cardinality
	): void {
		if (this.attributeSchemas.has(ident)) {
			return;
		}

		const existing = declared.get(ident);
		if (existing) {
			if (existing.valueType !== valueType || existing.cardinality !== cardinality) {
				throw new Error(`Schema conflict for ${ident}: conflicting auto-declared valueType/cardinality`);
			}
			return;
		}

		declared.set(ident, { ident, valueType, cardinality });
	}

	/**
	 * Resolves one scalar value in the object grammar. Bare `temp()` is rejected
	 * (same rule as the tuple surface); `lookupRef()` values resolve to `ref()`
	 * against `db/unique: 'identity'` holders (P1 upsert resolution), raising
	 * when nothing matches; `ref(temp())` / `ref(negative)` resolve to the
	 * tempid's allocated id.
	 */
	private resolveInsertValue(
		value: unknown,
		tempids: Map<string, number>,
		identityMap: Map<string, EntityId>
	): unknown {
		if (isTemp(value)) {
			throw new Error('temp() can only be used as an entity id or wrapped in ref()');
		}

		if (isLookupRef(value)) {
			return ref(this.resolveLookupRefTarget(value, identityMap));
		}

		if (!isRef(value)) {
			return value;
		}

		const target = value[REF_BRAND];
		if (isLookupRef(target)) {
			return ref(this.resolveLookupRefTarget(target, identityMap));
		}

		if (isTemp(target)) {
			return ref(this.tempidId(`t:${target[TEMP_BRAND]}`, tempids));
		}

		if (typeof target === 'number' && target < 0) {
			return ref(this.tempidId(`n:${target}`, tempids));
		}

		return value;
	}

	/**
	 * Identity-attribute variant of `resolveInsertValue`: a lookupRef on the
	 * attribute's own identity-unique key is an upsert marker — the plain scalar
	 * is stored, not a ref to the matched entity.
	 */
	private resolveInsertValueForKey(
		key: string,
		value: unknown,
		tempids: Map<string, number>,
		identityMap: Map<string, EntityId>
	): unknown {
		if (isLookupRef(value)) {
			const [attribute, scalar] = value[LOOKUP_REF_BRAND];
			if (attribute === key && this.attributeSchemas.get(key)?.unique === 'identity') {
				return scalar;
			}
			return ref(this.resolveLookupRefTarget(value, identityMap));
		}

		if (isRef(value) && isLookupRef(value[REF_BRAND])) {
			const [attribute, scalar] = value[REF_BRAND][LOOKUP_REF_BRAND];
			if (attribute === key && this.attributeSchemas.get(key)?.unique === 'identity') {
				return scalar;
			}
		}

		return this.resolveInsertValue(value, tempids, identityMap);
	}

	private resolveLookupRefTarget(lookup: LookupRef, identityMap: Map<string, EntityId>): EntityId {
		const [attribute, value] = lookup[LOOKUP_REF_BRAND];
		const key = `lookupRef:${attribute}:${valueKey(value)}`;
		const inTransaction = identityMap.get(key);
		if (inTransaction !== undefined) {
			return inTransaction;
		}

		const existing = this.resolveIdentityTarget(attribute, value);
		if (existing === null) {
			throw new Error(
				`lookupRef([${attribute}, ${JSON.stringify(value)}]) does not match any entity (no db/unique: 'identity' holder)`
			);
		}

		identityMap.set(key, existing);
		return existing;
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

	/**
	 * Diff-based update (design/02): compares the requested attribute values
	 * against the entity's current state and emits retract+add pairs in one
	 * transaction. `null` means retract. Cardinality-many attributes diff as
	 * sets (arrays replace the member set, scalars replace it with one member);
	 * one-valued attributes retract-then-add on change.
	 */
	private applyChanges(
		eid: EntityId,
		attributeOrChanges: string | Record<string, unknown>,
		value?: unknown
	): Fact[] {
		const changes: Record<string, unknown> =
			typeof attributeOrChanges === 'string' ? { [attributeOrChanges]: value } : attributeOrChanges;
		if (Object.keys(changes).length === 0) {
			return [];
		}

		const mutations: Mutation[] = [];
		for (const [attribute, next] of Object.entries(changes)) {
			const schema = this.attributeSchemas.get(attribute);
			const currentValues = this.activeValues(eid, attribute);

			if (schema?.cardinality === 'many') {
				const nextValues = next === null ? [] : Array.isArray(next) ? next : [next];
				const current = new Map<string, unknown>(currentValues.map((v) => [valueKey(v), v] as const));
				const target = new Map<string, unknown>(nextValues.map((v) => [valueKey(v), v] as const));

				for (const [key, currentValue] of current) {
					if (!target.has(key)) {
						mutations.push(['retract', eid, attribute, currentValue]);
					}
				}
				for (const [key, nextValue] of target) {
					if (!current.has(key)) {
						mutations.push(['add', eid, attribute, nextValue]);
					}
				}
				continue;
			}

			const currentValue = currentValues[0];
			if (next === null) {
				if (currentValue !== undefined) {
					mutations.push(['retract', eid, attribute, currentValue]);
				}
				continue;
			}

			if (currentValue === undefined || !sameValue(currentValue, next)) {
				if (currentValue !== undefined) {
					mutations.push(['retract', eid, attribute, currentValue]);
				}
				mutations.push(['add', eid, attribute, next]);
			}
		}

		if (mutations.length === 0) {
			return [];
		}

		return this.transact(mutations);
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

		// Snapshot (eid, attribute) pairs that do not exist yet: a fact
		// introducing a brand-new pair is always relevant to live queries even
		// when the entity was not a candidate at the last evaluation.
		const newPairs = new Set<string>();
		for (const [, eid, attribute] of mutations) {
			const attrId = this.attributeIds.get(attribute);
			if (attrId === undefined || !this.aevt.get(attrId)?.has(eid)) {
				newPairs.add(livePairKey(eid, attribute));
			}
		}

		const facts = mutations.map(([op, eid, attribute, value]) => {
			const fact = this.appendFact(tx, op, eid, attribute, value);
			this.onFactCommitted(fact);
			return fact;
		});

		this.notifyLive(facts, newPairs);
		return facts;
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
		const attrId = this.attributeIds.get(attribute);
		const attributeEntities = attrId === undefined ? undefined : this.aevt.get(attrId);
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
		const attrId = this.attributeIds.get(attribute);
		if (attrId === undefined) {
			return [];
		}

		return this.eavt.get(eid)?.get(attrId)?.slice() ?? [];
	}

	getFactsByAttributeValue(attribute: string, value: unknown): readonly Fact[] {
		const attrId = this.attributeIds.get(attribute);
		if (attrId === undefined) {
			return [];
		}

		return this.avet.get(attrId)?.get(valueKey(value))?.slice() ?? [];
	}

	getTransactions(): readonly TransactionRecord[] {
		return this.transactions.slice();
	}

	/**
	 * Restores a previously persisted snapshot (design/04 persistence): the fact
	 * log and transaction ledger are replayed verbatim, preserving tx numbering,
	 * schema state (negative schema eids are kept — they are never tempids), and
	 * index contents, so a restored database behaves identically to the one that
	 * saved the snapshot. Only callable on a fresh database (no facts or
	 * transactions yet); throws otherwise.
	 */
	restore(snapshot: DatabaseSnapshot): void {
		if (this.facts.length > 0 || this.transactions.length > 0) {
			throw new Error('restore() can only be called on an empty database');
		}

		const { facts, transactions } = snapshot;
		validateSnapshotOrder(facts, transactions);

		for (const transaction of transactions) {
			this.transactions.push(transaction);
		}

		let maxTx = 0;
		let minSchemaEid = 0;
		let maxEntityEid = 0;
		for (const fact of facts) {
			const [eid, attribute, value, tx, op] = fact;
			if (tx > maxTx) {
				maxTx = tx;
			}
			if (typeof eid === 'number' && eid < minSchemaEid) {
				minSchemaEid = eid;
			}
			if (typeof eid === 'number' && eid > maxEntityEid) {
				maxEntityEid = eid;
			}

			this.appendFact(tx, op, eid, attribute, value);
			this.onFactCommitted(fact);
		}

		this.nextTx = maxTx + 1;
		this.nextSchemaEid = minSchemaEid - 1;
		this.nextEntityEid = maxEntityEid + 1;
		// `db/unique` schema facts and value facts can interleave arbitrarily in
		// the log; rather than trusting the incremental replay order, drop the
		// unique index so it rebuilds lazily from the AEVT index on the next write.
		this.uniqueIndex.clear();
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

	entity(eid: EntityId, tx?: number, options?: EntityReadOptions): EntityState | null {
		const txLimit = normalizeTxLimit(tx);
		const refs = options?.refs ?? 'id';
		const entityAttributes = this.eavt.get(eid);
		if (!entityAttributes) {
			return null;
		}

		const state = new Map<string, unknown>();

		for (const [attrId, facts] of entityAttributes) {
			const attribute = this.attributeIdents.get(attrId) as string;
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
			entity[attribute] =
				value instanceof Map
					? Object.freeze(Array.from(value.values(), (item) => unwrapRefValue(item, refs)))
					: unwrapRefValue(value, refs);
		}

		const frozen = Object.freeze(entity);
		return this.tracking === null ? frozen : this.wrapTrackedEntity(frozen);
	}

	find(criteria: Record<string, unknown>, options?: number | FindOptions): EntityState[] {
		const opts: FindOptions = typeof options === 'number' ? { tx: options } : (options ?? {});
		const txLimit = normalizeTxLimit(opts.tx);

		if (this.tracking !== null) {
			for (const key of Object.keys(criteria)) {
				if (key !== 'id') {
					this.tracking.attributes.add(this.internAttribute(key));
				}
			}
		}

		const matches: EntityState[] = [];

		for (const eid of this.candidateEidsForCriteria(criteria, txLimit)) {
			const entity = this.entity(eid, txLimit, { refs: opts.refs ?? 'id' });
			if (!entity) {
				continue;
			}

			if (this.entityMatchesCriteria(entity, criteria, txLimit)) {
				matches.push(entity);
			}
		}

		let result = matches;
		if (opts.orderBy) {
			result = this.orderEntities(result, opts.orderBy);
		}
		if (opts.offset) {
			result = result.slice(opts.offset);
		}
		if (opts.limit !== undefined) {
			result = result.slice(0, opts.limit);
		}
		if (opts.select) {
			result = result.map((entity) => this.selectEntity(entity, opts.select as string[]));
		}

		return result;
	}

	private entityMatchesCriteria(entity: EntityState, criteria: Record<string, unknown>, txLimit: number): boolean {
		for (const [key, criterion] of Object.entries(criteria)) {
			if (key === 'id') {
				if (!criterionMatchesValue([entity.id], criterion)) {
					return false;
				}
				continue;
			}

			const values = this.attributeValues(entity.id, key, txLimit);
			if (!criterionMatchesValue(values, criterion)) {
				return false;
			}
		}

		return true;
	}

	/** Stable multi-key ordering; missing attributes sort first in both directions. */
	private orderEntities(matches: EntityState[], orderBy: OrderBy | OrderBy[]): EntityState[] {
		const raw = orderBy as OrderBy[];
		if (raw.length === 0) {
			return matches;
		}

		const pairs: OrderBy[] = Array.isArray(raw[0]) ? raw : [orderBy as OrderBy];
		const decorated = matches.map((entity, index) => ({ entity, index }));
		decorated.sort((left, right) => {
			for (const [attribute, direction] of pairs) {
				const leftValue = left.entity[attribute];
				const rightValue = right.entity[attribute];
				const cmp = compareOrderValues(
					Array.isArray(leftValue) ? leftValue[0] : leftValue,
					Array.isArray(rightValue) ? rightValue[0] : rightValue
				);
				if (cmp !== 0) {
					return direction === 'asc' ? cmp : -cmp;
				}
			}

			return left.index - right.index;
		});

		return decorated.map(({ entity }) => entity);
	}

	private selectEntity(entity: EntityState, select: string[]): EntityState {
		const picked: Record<string, unknown> = { id: entity.id };
		for (const key of select) {
			if (key === 'id') {
				continue;
			}

			if (key in entity) {
				picked[key] = entity[key];
			}
		}

		return Object.freeze(picked) as EntityState;
	}

	/**
	 * Returns candidate entity ids (in global first-fact order) that could match
	 * the criteria, narrowed through the AVET/AEVT indexes. Operator criteria
	 * narrow only where an exact AVET key exists ($eq/$in/$contains); range and
	 * presence operators fall back to every entity and rely on the full match
	 * check in `find`. Correctness always comes from `entityMatchesCriteria`.
	 */
	private candidateEidsForCriteria(criteria: Record<string, unknown>, txLimit: number): EntityId[] {
		const entries = Object.entries(criteria);
		if (entries.length === 0) {
			return [...this.eavt.keys()];
		}

		const sets: Array<Set<EntityId>> = [];
		for (const [key, criterion] of entries) {
			const eids = new Set<EntityId>();

			if (key === 'id') {
				if (isFindOperator(criterion)) {
					if (criterion.$eq !== undefined && (typeof criterion.$eq === 'number' || typeof criterion.$eq === 'string')) {
						eids.add(criterion.$eq);
					} else if (Array.isArray(criterion.$in)) {
						for (const item of criterion.$in) {
							if (typeof item === 'number' || typeof item === 'string') {
								eids.add(item);
							}
						}
					} else {
						this.addAllEids(eids);
					}
				} else if (typeof criterion === 'number' || typeof criterion === 'string') {
					eids.add(criterion);
				} else {
					this.addAllEids(eids);
				}
				sets.push(eids);
				continue;
			}

			if (isFindOperator(criterion)) {
				if (criterion.$eq !== undefined) {
					this.addAvetCandidates(eids, key, criterion.$eq, txLimit);
				} else if (Array.isArray(criterion.$in) && criterion.$in.length > 0) {
					for (const item of criterion.$in) {
						this.addAvetCandidates(eids, key, item, txLimit);
					}
				} else if (criterion.$contains !== undefined) {
					this.addAvetCandidates(eids, key, criterion.$contains, txLimit);
				} else {
					this.addAllEids(eids);
				}
				sets.push(eids);
				continue;
			}

			this.addAvetCandidates(eids, key, criterion, txLimit);
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

	private addAvetCandidates(eids: Set<EntityId>, attribute: string, value: unknown, txLimit: number): void {
		const attrId = this.attributeIds.get(attribute);
		if (attrId === undefined) {
			return;
		}

		const valueFacts = this.avet.get(attrId)?.get(valueKey(value));
		if (!valueFacts) {
			return;
		}

		for (const fact of valueFacts) {
			if (fact[3] <= txLimit) {
				eids.add(fact[0]);
			}
		}
	}

	private addAllEids(eids: Set<EntityId>): void {
		for (const eid of this.eavt.keys()) {
			eids.add(eid);
		}
	}

	private orderCandidates(eids: Set<EntityId>): EntityId[] {
		const ordered: EntityId[] = [];
		for (const eid of this.eavt.keys()) {
			if (eids.has(eid)) {
				ordered.push(eid);
			}
		}

		return ordered;
	}

	/**
	 * Dot-path selection (design/02). Each path is a '.'-separated attribute
	 * walk: at every level the longest segment prefix whose '/' join names an
	 * active attribute is consumed (so `user.name` reads `user/name`), and ref
	 * attributes (schema `db/ref` / `valueType: 'ref'`, or ref()-valued) are
	 * traversed into nested objects that carry `id`. Many-valued refs yield
	 * arrays; multiple paths deep-merge into one result.
	 */
	pull(eid: EntityId, paths: PullPath, tx?: number): EntityState | null {
		const txLimit = normalizeTxLimit(tx);
		if (this.entity(eid, txLimit) === null) {
			return null;
		}

		const pathList = Array.isArray(paths) ? paths : paths.trim().split(/\s+/).filter((path) => path.length > 0);
		const result: Record<string, unknown> = { id: eid };
		for (const path of pathList) {
			const segments = path.split('.').filter((segment) => segment.length > 0);
			if (segments.length === 0) {
				continue;
			}

			const fragment = this.pullPath(eid, segments, txLimit);
			if (fragment !== null) {
				mergePullFragments(result, fragment);
			}
		}

		return Object.freeze(result) as EntityState;
	}

	private pullPath(eid: EntityId, segments: string[], txLimit: number): Record<string, unknown> | null {
		for (let length = segments.length; length >= 1; length -= 1) {
			const attribute = segments.slice(0, length).join('/');
			const values = this.attributeValues(eid, attribute, txLimit);
			if (values.length === 0) {
				continue;
			}

			const rest = segments.slice(length);
			const schema = this.attributeSchemas.get(attribute);
			const refAttribute = schema?.ref === true || schema?.valueType === 'ref';

			if (rest.length === 0) {
				if (refAttribute) {
					const ids = values
						.map((value) => this.pullRefTarget(value))
						.filter((target): target is EntityId => target !== null);
					if (ids.length > 0) {
						return {
							[attribute]: ids.length === 1 ? { id: ids[0] } : ids.map((id) => ({ id }))
						};
					}
				}

				return { [attribute]: values.length === 1 ? values[0] : values };
			}

			if (!refAttribute && !values.some((value) => isRef(value) || isLookupRef(value))) {
				return null; // scalar attribute cannot be traversed
			}

			const nested: Array<Record<string, unknown>> = [];
			for (const value of values) {
				const target = this.pullRefTarget(value);
				if (target === null) {
					continue;
				}

				const fragment = this.pullPath(target, rest, txLimit);
				if (fragment !== null) {
					nested.push({ id: target, ...fragment });
				}
			}

			if (nested.length === 0) {
				return null;
			}

			return { [attribute]: nested.length === 1 ? nested[0] : nested };
		}

		return null;
	}

	private pullRefTarget(value: unknown): EntityId | null {
		if (isRef(value)) {
			const target = value[REF_BRAND];
			if (isLookupRef(target)) {
				return this.resolveIdentityTarget(target[LOOKUP_REF_BRAND][0], target[LOOKUP_REF_BRAND][1]);
			}

			if (typeof target === 'number' || typeof target === 'string') {
				return target;
			}

			return null;
		}

		if (isLookupRef(value)) {
			return this.resolveIdentityTarget(value[LOOKUP_REF_BRAND][0], value[LOOKUP_REF_BRAND][1]);
		}

		return null;
	}

	/**
	 * A transaction-scoped read view (design/02 time travel). `atTransaction`
	 * remains as an alias.
	 */
	at(tx: number): {
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

	atTransaction(tx: number): {
		entity: (eid: EntityId) => EntityState | null;
		find: (criteria: Record<string, unknown>, options?: FindOptions) => EntityState[];
		query: (spec: QuerySpec) => QueryTerm[][];
		pull: (eid: EntityId, paths: PullPath) => EntityState | null;
	} {
		return this.at(tx);
	}

	/**
	 * The facts committed in transactions (min(txA, txB), max(txA, txB)],
	 * grouped by operation — the primitive for DevTools timelines and undo/redo.
	 */
	diff(txA: number, txB: number): DiffResult {
		const from = Math.min(txA, txB);
		const to = Math.max(txA, txB);
		const added: Fact[] = [];
		const retracted: Fact[] = [];

		for (const fact of this.facts) {
			if (fact[3] > from && fact[3] <= to) {
				if (fact[4] === 'add') {
					added.push(fact);
				} else {
					retracted.push(fact);
				}
			}
		}

		return { added, retracted };
	}

	/**
	 * Live query (design/03). Three forms:
	 *
	 * - `live(fn)` — access tracking: `fn` receives the database as its first
	 *   argument (`db.live(db => db.find(...))`, design/03) and while it runs,
	 *   entity attribute reads (plus `find` criteria / `query` where
	 *   attributes) are recorded via proxies, and the recorded set narrows the
	 *   subscription key through the AEVT index. Writes touching only
	 *   unrelated attributes do not re-run `fn`; the result is memoized and
	 *   diffed so subscribers are notified only on actual change.
	 * - `live(deps, fn)` — explicit-dependency variant, no Proxy.
	 * - `live(specOrCriteria)` — direct QuerySpec / find-criteria form.
	 */
	live<T>(fn: (db: FactDatabase) => T): LiveResult<T>;
	live<T>(deps: readonly string[], fn: () => T): LiveResult<T>;
	live(spec: QuerySpec): LiveResult<QueryTerm[][]>;
	live(criteria: Record<string, unknown>): LiveResult<EntityState[]>;
	live<T>(
		input: ((db: FactDatabase) => T) | readonly string[] | QuerySpec | Record<string, unknown>,
		fn?: () => T
	): LiveResult<T> | LiveResult<QueryTerm[][]> | LiveResult<EntityState[]> {
		return this.createLiveResult(this.buildLiveHandle(input, fn));
	}

	/**
	 * Live query as an async iterable (design/03): yields the initial result,
	 * then each subsequent change. Cancellation via `AbortSignal`, the
	 * iterator's `return()`/`throw()`, or `dispose()`.
	 */
	liveQuery(spec: QuerySpec, options?: LiveQueryOptions): LiveQueryResult<QueryTerm[][]>;
	liveQuery(criteria: Record<string, unknown>, options?: LiveQueryOptions): LiveQueryResult<EntityState[]>;
	liveQuery<T>(
		input: QuerySpec | Record<string, unknown>,
		options?: LiveQueryOptions
	): LiveQueryResult<T> | LiveQueryResult<QueryTerm[][]> | LiveQueryResult<EntityState[]> {
		return this.createLiveQueryResult(this.buildLiveHandle<T>(input), options);
	}

	query(spec: QuerySpec, tx?: number): QueryTerm[][] {
		const txLimit = normalizeTxLimit(tx);

		if (this.tracking !== null) {
			for (const [, attribute] of spec.where) {
				this.tracking.attributes.add(this.internAttribute(attribute));
			}
		}

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
			// Textbook datalog with per-clause candidate sets (fixes the P0
			// cross-variable narrowing logged in issues.md): an unbound entity
			// variable ranges over the entities matching ITS OWN clause, not the
			// intersection of every clause's candidates. Each per-clause set is
			// ordered by global first-fact order, so result ordering stays
			// deterministic: unbound entity variables expand in first-fact order
			// and bound variables expand their values in insertion order.
			const clauseCandidates = where.map((clause) => this.candidateEidsForClause(clause, txLimit));
			const clauseCandidateSets = clauseCandidates.map((candidates) => new Set(candidates));

			for (let clauseIndex = 0; clauseIndex < where.length; clauseIndex += 1) {
				const [entityTerm, attribute, valueTerm] = where[clauseIndex] as QueryClause;
				const candidates = clauseCandidates[clauseIndex];
				const candidateSet = clauseCandidateSets[clauseIndex];

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
	 * satisfy the clause's value term. Operator terms are evaluated against the
	 * active values (same semantics as `find`); constant terms use the canonical
	 * value key on cardinality-many attributes and on non-QueryTerm constants
	 * (Date / bigint / ref / lookupRef), keeping Object.is semantics for scalar
	 * constants on cardinality-one attributes.
	 */
	private hasAttributeValue(eid: EntityId, attribute: string, value: QueryValueTerm, txLimit: number): boolean {
		if (isFindOperator(value)) {
			return criterionMatchesValue(this.attributeValues(eid, attribute, txLimit), value);
		}

		const attrId = this.attributeIds.get(attribute);
		if (attrId === undefined) {
			return false;
		}

		const facts = this.eavt.get(eid)?.get(attrId);
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

		if (current === undefined) {
			return false;
		}

		if (isQueryTerm(value)) {
			return isQueryTerm(current) && Object.is(current, value);
		}

		return sameValue(current, value);
	}

	/**
	 * Returns entity ids (in global first-fact order) that can satisfy THIS
	 * clause's attribute/value constraint, narrowed via the AVET/AEVT indexes.
	 * Operator terms narrow only where an exact AVET key exists ($eq/$in/
	 * $contains); range/presence operators fall back to every entity and rely on
	 * `hasAttributeValue` for correctness. Per-clause sets are what the join
	 * iterates for unbound entity variables (textbook datalog semantics).
	 */
	private candidateEidsForClause(clause: QueryClause, txLimit: number): EntityId[] {
		const [entityTerm, attribute, valueTerm] = clause;
		const eids = new Set<EntityId>();

		if ((typeof entityTerm === 'number' || typeof entityTerm === 'string') && !isVariable(entityTerm)) {
			eids.add(entityTerm);
			return [...eids];
		}

		if (isFindOperator(valueTerm)) {
			if (valueTerm.$eq !== undefined) {
				this.addAvetCandidates(eids, attribute, valueTerm.$eq, txLimit);
			} else if (Array.isArray(valueTerm.$in) && valueTerm.$in.length > 0) {
				for (const item of valueTerm.$in) {
					this.addAvetCandidates(eids, attribute, item, txLimit);
				}
			} else if (valueTerm.$contains !== undefined) {
				this.addAvetCandidates(eids, attribute, valueTerm.$contains, txLimit);
			} else {
				this.addAllEids(eids);
			}
			return this.orderCandidates(eids);
		}

		if (!isVariable(valueTerm)) {
			this.addAvetCandidates(eids, attribute, valueTerm, txLimit);
			return this.orderCandidates(eids);
		}

		const attrId = this.attributeIds.get(attribute);
		const attributeEntities = attrId === undefined ? undefined : this.aevt.get(attrId);
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

		return this.orderCandidates(eids);
	}

	/**
	 * Extracts the active value(s) of one attribute for an entity as of a
	 * transaction limit, straight from the EAVT index. Mirrors the entity-state
	 * reconstruction for a single attribute: cardinality-many returns the values
	 * in insertion order (re-adds move to the end), anything else is last-wins.
	 */
	private attributeValues(eid: EntityId, attribute: string, txLimit: number): unknown[] {
		const attrId = this.attributeIds.get(attribute);
		if (attrId === undefined) {
			return [];
		}

		const facts = this.eavt.get(eid)?.get(attrId);
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

	/**
	 * Runs `fn` with access tracking active and returns its result plus the
	 * recorded reads. The previous tracker (if any — nested `live` selectors)
	 * is restored afterwards.
	 */
	private runTracked<T>(fn: () => T): { result: T; tracker: AccessTracker } {
		const previous = this.tracking;
		const tracker: AccessTracker = { attributes: new Set(), eidsByAttribute: new Map() };
		this.tracking = tracker;
		try {
			return { result: fn(), tracker };
		} finally {
			this.tracking = previous;
		}
	}

	/** Wraps a frozen entity state in a Proxy that records attribute reads. */
	private wrapTrackedEntity(entity: EntityState): EntityState {
		const tracker = this.tracking as AccessTracker;
		return new Proxy(entity, {
			get: (target, prop, receiver) => {
				if (typeof prop === 'string' && prop !== 'id') {
					const attrId = this.internAttribute(prop);
					tracker.attributes.add(attrId);
					let eids = tracker.eidsByAttribute.get(attrId);
					if (!eids) {
						eids = new Set();
						tracker.eidsByAttribute.set(attrId, eids);
					}
					eids.add(target.id);
				}
				return Reflect.get(target, prop, receiver) as unknown;
			}
		});
	}

	/** Dispatches a `live`/`liveQuery` input to a LiveHandle with an initial evaluation. */
	private buildLiveHandle<T>(
		input: ((db: FactDatabase) => T) | readonly string[] | QuerySpec | Record<string, unknown>,
		fn?: () => T
	): LiveHandle<T> {
		if (typeof input === 'function') {
			// Access-tracking form: the selector receives the database (design/03);
			// existing no-arg selectors ignore the extra argument.
			return this.createLiveHandle(() => input(this), true, null);
		}

		if (isStringArray(input)) {
			if (fn === undefined) {
				throw new Error('live(deps, fn) requires a selector function');
			}
			return this.createLiveHandle(
				fn,
				false,
				new Set(input.map((dep) => this.internAttribute(dep)))
			);
		}

		if (isQuerySpec(input)) {
			const attributes = new Set<number>();
			for (const [, attribute] of input.where) {
				attributes.add(this.internAttribute(attribute));
			}
			return this.createLiveHandle(() => this.query(input) as T, false, attributes);
		}

		const criteria = input;
		const attributes = new Set<number>();
		for (const key of Object.keys(criteria)) {
			if (key !== 'id') {
				attributes.add(this.internAttribute(key));
			}
		}
		return this.createLiveHandle(() => this.find(criteria) as T, false, attributes);
	}

	/** Creates a LiveHandle and runs its initial evaluation before registering it. */
	private createLiveHandle<T>(read: () => T, trackReads: boolean, explicitDeps: ReadonlySet<number> | null): LiveHandle<T> {
		const handle: LiveHandle<T> = {
			read,
			trackReads,
			explicitDeps,
			dependencies: new Map(),
			fallbackAll: false,
			listeners: new Set(),
			memoKey: null,
			memoValue: null,
			hasValue: false,
			disposed: false
		};
		this.evaluateLive(handle);
		this.liveInstances.add(handle as LiveHandle<unknown>);
		return handle;
	}

	/** Exposes a handle as the public `{ current, subscribe, dispose }` shape. */
	private createLiveResult<T>(handle: LiveHandle<T>): LiveResult<T> {
		return {
			get current(): T {
				return handle.memoValue as T;
			},
			subscribe: (callback: (value: T) => void): (() => void) => {
				if (handle.disposed) {
					return () => {};
				}
				handle.listeners.add(callback);
				return () => {
					handle.listeners.delete(callback);
				};
			},
			dispose: (): void => {
				if (handle.disposed) {
					return;
				}
				handle.disposed = true;
				handle.listeners.clear();
				this.liveInstances.delete(handle as LiveHandle<unknown>);
			}
		};
	}

	/**
	 * Wraps a live handle in an async iterable (design/03): yields the initial
	 * result, then each subsequent change, buffering deltas that arrive while
	 * the consumer is idle. AbortSignal, iterator `return()`/`throw()`, and
	 * `dispose()` all stop delivery.
	 */
	private createLiveQueryResult<T>(handle: LiveHandle<T>, options?: LiveQueryOptions): LiveQueryResult<T> {
		const liveResult = this.createLiveResult(handle);
		const signal = options?.signal;
		const queue: T[] = [];
		let resolveNext: (() => void) | null = null;
		let disposed = false;

		const unsubscribe = liveResult.subscribe((value) => {
			queue.push(value);
			if (resolveNext !== null) {
				resolveNext();
				resolveNext = null;
			}
		});

		const dispose = (): void => {
			if (disposed) {
				return;
			}
			disposed = true;
			unsubscribe();
			if (signal) {
				signal.removeEventListener('abort', abort);
			}
			liveResult.dispose();
			if (resolveNext !== null) {
				resolveNext();
				resolveNext = null;
			}
		};

		const abort = (): void => {
			dispose();
		};

		if (signal) {
			if (signal.aborted) {
				dispose();
			} else {
				signal.addEventListener('abort', abort, { once: true });
			}
		}

		return {
			get current(): T {
				return handle.memoValue as T;
			},
			subscribe: (callback: (value: T) => void): (() => void) => liveResult.subscribe(callback),
			dispose,
			// The generator idles on a never-settling `await new Promise(...)`
			// when no change is queued. Per V8 async-generator semantics a
			// `return()`/`throw()` issued while suspended there would not settle
			// until the pending await resolves (i.e. the next notification or
			// dispose()) — hanging indefinitely. The wrapper therefore disposes
			// first — resolving any pending idle await and flipping `disposed`
			// so the loop exits on wake — then delegates to the real generator,
			// whose `finally` runs and lets the return/throw complete.
			[Symbol.asyncIterator](): AsyncIterator<T> {
				const generator = (async function* (): AsyncGenerator<T> {
					try {
						if (disposed) {
							return;
						}
						// Changes that arrived before iteration started are already
						// reflected in `current`; drop the buffered duplicates.
						queue.length = 0;
						yield handle.memoValue as T;
						while (!disposed) {
							if (queue.length > 0) {
								yield queue.shift() as T;
							} else {
								await new Promise<void>((resolve) => {
									resolveNext = resolve;
								});
							}
						}
					} finally {
						dispose();
					}
				})();

				const wrapped = {
					next: (value?: unknown) => generator.next(value),
					return: (value?: unknown): Promise<IteratorResult<T>> => {
						dispose();
						return generator.return(value);
					},
					throw: (error?: unknown): Promise<IteratorResult<T>> => {
						dispose();
						return generator.throw(error);
					},
					[Symbol.asyncIterator]: () => wrapped
				};
				return wrapped;
			}
		};
	}

	/**
	 * Re-evaluates a live handle: runs the selector (with access tracking for
	 * the `live(fn)` form), refreshes the AEVT-narrowed dependency map, diffs
	 * the result against the memoized key, and notifies listeners only when
	 * the result actually changed (keeping the previous object identity
	 * otherwise).
	 */
	private evaluateLive<T>(handle: LiveHandle<T>): void {
		let tracker: AccessTracker | null = null;
		let value: T;
		if (handle.trackReads) {
			const tracked = this.runTracked(handle.read);
			tracker = tracked.tracker;
			value = tracked.result;
		} else {
			value = handle.read();
		}

		this.updateLiveDependencies(handle as LiveHandle<unknown>, tracker);

		const key = stableValueKey(value);
		if (handle.hasValue && key === handle.memoKey) {
			return;
		}

		handle.memoKey = key;
		handle.memoValue = value;
		handle.hasValue = true;

		for (const listener of [...handle.listeners]) {
			listener(value);
		}
	}

	/**
	 * Builds the subscription key: for every recorded (or explicitly listed)
	 * attribute, the candidate eid set is the union of the AEVT members at
	 * this evaluation and the entities the attribute was actually read on.
	 * With no recorded attributes the handle falls back to watching every
	 * write (a selector that reads nothing cannot be narrowed).
	 */
	private updateLiveDependencies(handle: LiveHandle<unknown>, tracker: AccessTracker | null): void {
		const attributes = handle.explicitDeps ?? tracker?.attributes ?? null;
		if (attributes === null || attributes.size === 0) {
			handle.fallbackAll = true;
			handle.dependencies = new Map();
			return;
		}

		handle.fallbackAll = false;
		const dependencies = new Map<number, Set<EntityId>>();
		for (const attribute of attributes) {
			const eids = new Set<EntityId>();
			const aevtEntities = this.aevt.get(attribute);
			if (aevtEntities) {
				for (const eid of aevtEntities.keys()) {
					eids.add(eid);
				}
			}
			if (tracker) {
				for (const eid of tracker.eidsByAttribute.get(attribute) ?? []) {
					eids.add(eid);
				}
			}
			dependencies.set(attribute, eids);
		}
		handle.dependencies = dependencies;
	}

	/**
	 * True when a committed fact can affect the handle's result: the fact's
	 * attribute is recorded and either its entity was a candidate at the last
	 * evaluation or the fact introduces a brand-new (entity, attribute) pair.
	 */
	private liveFactRelevant(handle: LiveHandle<unknown>, fact: Fact, newPairs: ReadonlySet<string>): boolean {
		if (handle.fallbackAll) {
			return true;
		}

		const [eid, attribute] = fact;
		const attrId = this.attributeIds.get(attribute);
		if (attrId === undefined) {
			return false;
		}

		const candidates = handle.dependencies.get(attrId);
		if (!candidates) {
			return false;
		}

		return candidates.has(eid) || newPairs.has(livePairKey(eid, attribute));
	}

	/** Re-evaluates every live handle touched by the transaction, once per transaction. */
	private notifyLive(facts: readonly Fact[], newPairs: ReadonlySet<string>): void {
		if (this.liveInstances.size === 0) {
			return;
		}

		const instances = [...this.liveInstances];
		for (const handle of instances) {
			if (handle.disposed) {
				continue;
			}
			if (facts.some((fact) => this.liveFactRelevant(handle, fact, newPairs))) {
				this.evaluateLive(handle);
			}
		}
	}

	private validateMutations(mutations: Mutation[]): void {
		const manyState = new Map<string, Map<string, unknown>>();
		const oneState = new Map<string, unknown>();
		// Tracks values retracted earlier in this transaction so a same-tx
		// retract-then-re-add (set/patch diff updates) does not re-see the
		// committed value and raise a false cardinality conflict.
		const oneRetracted = new Map<string, true>();
		const uniqueState = new Map<number, Map<string, Set<EntityId>>>();

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

			const current = oneState.has(key)
				? oneState.get(key)
				: oneRetracted.has(key)
					? undefined
					: this.activeValues(eid, attribute)[0];
			if (op === 'add') {
				if (current !== undefined && !Object.is(current, value)) {
					throw new Error(`Cardinality conflict for ${attribute}: expected one value`);
				}
				oneState.set(key, value);
				oneRetracted.delete(key);
				continue;
			}

			if (current !== undefined && Object.is(current, value)) {
				oneState.delete(key);
				oneRetracted.set(key, true);
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
		uniqueState: Map<number, Map<string, Set<EntityId>>>
	): void {
		const attrId = this.internAttribute(attribute);
		// Defensive copy: the committed index must never be mutated by a
		// transaction that later fails validation.
		const base = uniqueState.get(attrId) ?? this.activeUniqueHolders(attribute);
		const holders = new Map<string, Set<EntityId>>();
		for (const [key, set] of base) {
			holders.set(key, new Set(set));
		}

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
		uniqueState.set(attrId, holders);
	}

	/**
	 * Active (entity, value) holders for a unique attribute across all entities.
	 * Served from the commit-maintained unique index; the index entry is built
	 * lazily when a unique constraint is added to pre-existing facts.
	 */
	private activeUniqueHolders(attribute: string): Map<string, Set<EntityId>> {
		const attrId = this.attributeIds.get(attribute);
		if (attrId === undefined) {
			return new Map();
		}

		return this.uniqueIndex.get(attrId) ?? this.scanUniqueHolders(attrId);
	}

	private activeValues(eid: EntityId, attribute: string): unknown[] {
		return this.attributeValues(eid, attribute, Number.POSITIVE_INFINITY);
	}
}

export function createDatabase(): FactDatabase {
	return new FactDatabase();
}
