/**
 * Property-based tests for @fatos/core.
 *
 * Strategy: a reference model mirrors the documented fact-log semantics and is driven in
 * lock-step with a real FactDatabase through randomized operation sequences. Checkpoints
 * assert the database's observable behavior (facts, transactions, entity reconstruction,
 * find, query, time travel) matches the model, catching state-machine, ordering, and
 * schema regressions that hand-written examples miss.
 *
 * Uses fast-check (devDependency).
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
	createDatabase,
	type Cardinality,
	type EntityId,
	type Fact,
	type FactOperation,
	type Mutation,
	type QuerySpec,
	type QueryTerm,
	type ValueType
} from './index';

type EntityState = Record<string, unknown> & { id: EntityId };

const SCHEMA_BY_IDENT: Record<string, { valueType: ValueType; cardinality: Cardinality }> = {
	'user/name': { valueType: 'string', cardinality: 'one' },
	'user/age': { valueType: 'number', cardinality: 'one' },
	'user/active': { valueType: 'boolean', cardinality: 'one' },
	'user/tags': { valueType: 'string', cardinality: 'many' }
};

const ATTR_POOL = ['user/name', 'user/age', 'user/active', 'user/tags', 'user/note'] as const;

const EID_ARB = fc.oneof(fc.integer({ min: 0, max: 15 }), fc.constant('alpha'), fc.constant('beta'));
const VALUE_ARB = fc.oneof(
	fc.string({ maxLength: 6 }),
	fc.integer({ min: -1000, max: 1000 }),
	fc.boolean(),
	fc.constant(null)
);

/**
 * Reference model implementing the same semantics as FactDatabase: append-only facts,
 * monotonic transactions, schema-aware entity reconstruction, find and datalog query.
 * Deliberately a separate implementation so discrepancies surface as test failures.
 */
class Model {
	facts: Fact[] = [];
	txCount = 0;
	schema = new Map<string, { valueType: ValueType; cardinality: Cardinality }>();
	private nextSchemaEid = -1;

	beginTx(): void {
		this.txCount += 1;
	}

	applySchema(ident: string, valueType: ValueType, cardinality: Cardinality): void {
		this.schema.set(ident, { valueType, cardinality });
		this.beginTx();
		const eid = this.nextSchemaEid--;
		this.facts.push([eid, 'db/ident', ident, this.txCount, 'add']);
		this.facts.push([eid, 'db/valueType', valueType, this.txCount, 'add']);
		this.facts.push([eid, 'db/cardinality', cardinality, this.txCount, 'add']);
	}

	applyFact(op: FactOperation, eid: EntityId, attribute: string, value: unknown): Fact {
		const fact: Fact = [eid, attribute, value, this.txCount, op];
		this.facts.push(fact);
		return fact;
	}

	private manyAttrs(): Set<string> {
		const many = new Set<string>();
		for (const [ident, s] of this.schema) {
			if (s.cardinality === 'many') {
				many.add(ident);
			}
		}
		return many;
	}

	entity(eid: EntityId, tx = Number.POSITIVE_INFINITY): EntityState | null {
		const many = this.manyAttrs();
		const state = new Map<string, unknown | Set<unknown>>();
		for (const [feid, attr, value, ftx, op] of this.facts) {
			if (feid !== eid || ftx > tx) {
				continue;
			}

			if (many.has(attr)) {
				const current = state.get(attr);
				const values = current instanceof Set ? current : new Set<unknown>();
				if (op === 'add') {
					values.add(value);
				} else {
					values.delete(value);
				}

				if (values.size === 0) {
					state.delete(attr);
				} else {
					state.set(attr, values);
				}

				continue;
			}

			if (op === 'add') {
				state.set(attr, value);
			} else if (Object.is(state.get(attr), value)) {
				state.delete(attr);
			}
		}

		if (state.size === 0) {
			return null;
		}

		const entity: EntityState = { id: eid };
		for (const [attr, value] of state) {
			entity[attr] = value instanceof Set ? Array.from(value) : value;
		}

		return entity;
	}

	find(criteria: Record<string, unknown>, tx = Number.POSITIVE_INFINITY): EntityState[] {
		const eids = new Set<EntityId>();
		for (const [eid, , , ftx] of this.facts) {
			if (ftx <= tx) {
				eids.add(eid);
			}
		}

		const matches: EntityState[] = [];
		for (const eid of eids) {
			const entity = this.entity(eid, tx);
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

	private static isVariable(term: QueryTerm): term is string {
		return typeof term === 'string' && term.startsWith('?');
	}

	private bindTerm(
		binding: Record<string, QueryTerm>,
		term: QueryTerm,
		actualValue: QueryTerm
	): Record<string, QueryTerm> | null {
		if (!Model.isVariable(term)) {
			return Object.is(term, actualValue) ? binding : null;
		}

		if (!(term in binding)) {
			return { ...binding, [term]: actualValue };
		}

		return Object.is(binding[term], actualValue) ? binding : null;
	}

	triples(tx = Number.POSITIVE_INFINITY): Array<[EntityId, string, QueryTerm]> {
		const eids = new Set<EntityId>();
		for (const [eid, , , ftx] of this.facts) {
			if (ftx <= tx) {
				eids.add(eid);
			}
		}

		const triples: Array<[EntityId, string, QueryTerm]> = [];
		for (const eid of eids) {
			const entity = this.entity(eid, tx);
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

	query(spec: QuerySpec, tx = Number.POSITIVE_INFINITY): QueryTerm[][] {
		const triples = this.triples(tx);
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
			const row = spec.find.map((term) => (Model.isVariable(term) ? (binding[term] ?? null) : (term as QueryTerm)));
			const rowKey = JSON.stringify(row);
			if (seen.has(rowKey)) {
				continue;
			}

			seen.add(rowKey);
			rows.push(row);
		}

		return rows;
	}
}

// --- Plan generators ---------------------------------------------------------

type OpKind = 'add' | 'retract' | 'transactAddRetract' | 'transactAddAdd';

type Op = {
	kind: OpKind;
	eid: EntityId;
	attr: string;
};

type Plan = {
	config: Record<string, { declare: boolean; fixed: unknown }>;
	ops: Op[];
};

const CONFIG_ARB = fc.record({
	'user/name': fc.record({ declare: fc.boolean(), fixed: fc.string({ maxLength: 6 }) }),
	'user/age': fc.record({ declare: fc.boolean(), fixed: fc.integer({ min: 0, max: 99 }) }),
	'user/active': fc.record({ declare: fc.boolean(), fixed: fc.boolean() }),
	'user/tags': fc.record({ declare: fc.boolean(), fixed: fc.string({ maxLength: 6 }) })
});

const OP_ARB: fc.Arbitrary<Op> = fc.record({
	kind: fc.constantFrom('add', 'retract', 'transactAddRetract', 'transactAddAdd'),
	eid: EID_ARB,
	attr: fc.constantFrom(...ATTR_POOL)
});

const PLAN_ARB: fc.Arbitrary<Plan> = fc.record({
	config: CONFIG_ARB,
	ops: fc.array(OP_ARB, { minLength: 0, maxLength: 40 })
});

// Deterministic per-index value used for attrs without a schema-one fixed value.
const NOTE_POOL: unknown[] = ['hello', 42, true, null, [1, 2], 0, -0];

function valueForOp(attr: string, i: number): unknown {
	switch (attr) {
		case 'user/name':
			return 'name-' + (i % 4);
		case 'user/age':
			return (i * 7) % 100;
		case 'user/active':
			return i % 2 === 0;
		case 'user/tags':
			return 'tag-' + (i % 3);
		case 'user/note':
			return NOTE_POOL[i % NOTE_POOL.length];
		default:
			return 'v-' + i;
	}
}

// Derived read inputs (shared by db and model — identical inputs, must be identical outputs).
function derivedCriteria(i: number): Record<string, unknown> {
	const picks: Array<Record<string, unknown>> = [
		{ 'user/name': 'name-' + (i % 4) },
		{ 'user/active': i % 2 === 0 },
		{ 'user/age': (i * 7) % 100 },
		{ 'user/tags': 'tag-' + (i % 3) },
		{}
	];
	return picks[i % picks.length];
}

function derivedSpec(i: number): QuerySpec {
	if (i % 10 === 0) {
		return {
			find: ['?e', '?n', '?a'],
			where: [
				['?e', 'user/name', '?n'],
				['?e', 'user/age', '?a']
			]
		};
	}

	const attr = ATTR_POOL[i % ATTR_POOL.length];
	return { find: ['?e', '?v'], where: [['?e', attr, '?v']] };
}

// --- Execution --------------------------------------------------------------

function checkpoint(db: ReturnType<typeof createDatabase>, model: Model, i: number): void {
	// Fact log and transaction ledger match the model exactly.
	expect(db.getFacts()).toEqual(model.facts);
	const txs = db.getTransactions();
	expect(txs).toHaveLength(model.txCount);
	for (let t = 1; t <= model.txCount; t += 1) {
		expect(txs[t - 1][0]).toBe(t);
	}

	// Entity reconstruction (current + historical) matches the model.
	const sampleEids: EntityId[] = [0, 7, 15, 'alpha', 'beta'];
	const cutoffs = [0, Math.floor(model.txCount / 2), model.txCount];
	for (const eid of sampleEids) {
		for (const tx of cutoffs) {
			expect(db.entity(eid, tx)).toEqual(model.entity(eid, tx));
		}
	}

	// find and query match the model on shared derived inputs.
	if (i % 5 === 0) {
		const criteria = derivedCriteria(i);
		expect(db.find(criteria)).toEqual(model.find(criteria));
		const spec = derivedSpec(i);
		expect(db.query(spec)).toEqual(model.query(spec));
	}
}

function runPlan(db: ReturnType<typeof createDatabase>, model: Model, plan: Plan): void {
	const fixedOne = new Map<string, unknown>();

	// Schema phase.
	for (const [ident, entry] of Object.entries(plan.config)) {
		if (!entry.declare) {
			continue;
		}

		const s = SCHEMA_BY_IDENT[ident];
		db.transact([{ ident, valueType: s.valueType, cardinality: s.cardinality }]);
		model.applySchema(ident, s.valueType, s.cardinality);
		if (s.cardinality === 'one') {
			fixedOne.set(ident, entry.fixed);
		}
	}
	expect(db.getFacts()).toEqual(model.facts);

	// Operation phase.
	for (let i = 0; i < plan.ops.length; i += 1) {
		const op = plan.ops[i];
		const value = fixedOne.has(op.attr) ? fixedOne.get(op.attr) : valueForOp(op.attr, i);

		if (op.kind === 'add' || op.kind === 'retract') {
			const fact = op.kind === 'add' ? db.add(op.eid, op.attr, value) : db.retract(op.eid, op.attr, value);
			model.beginTx();
			expect(fact).toEqual(model.applyFact(op.kind, op.eid, op.attr, value));
		} else {
			const mutations: Mutation[] =
				op.kind === 'transactAddAdd'
					? [
							['add', op.eid, op.attr, value],
							['add', op.eid, op.attr, value]
						]
					: [
							['add', op.eid, op.attr, value],
							['retract', op.eid, op.attr, value]
						];
			const facts = db.transact(mutations);
			model.beginTx();
			expect(facts).toEqual(mutations.map((m) => model.applyFact(m[0], m[1], m[2], m[3])));
		}

		checkpoint(db, model, i);
	}
}

// --- Property test cases ----------------------------------------------------

describe('property: model-based consistency (schema + operations)', () => {
	it('database observable state matches the reference model under randomized operations', () => {
		fc.assert(
			fc.property(PLAN_ARB, (plan) => {
				const db = createDatabase();
				const model = new Model();
				runPlan(db, model, plan);
			}),
			{ numRuns: 60 }
		);
	});
});

describe('property: fact log invariants', () => {
	it('committed facts are well-formed and transactions are monotonic', () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						kind: fc.constantFrom('add', 'retract'),
						eid: EID_ARB,
						attr: fc.constantFrom('a', 'b', 'c'),
						value: fc.oneof(fc.integer(), fc.string({ maxLength: 6 }), fc.boolean(), fc.constant(null))
					}),
					{ minLength: 1, maxLength: 60 }
				),
				(ops) => {
					const db = createDatabase();
					for (const op of ops) {
						if (op.kind === 'add') {
							db.add(op.eid, op.attr, op.value);
						} else {
							db.retract(op.eid, op.attr, op.value);
						}
					}

					const facts = db.getFacts();
					const txs = db.getTransactions();
					expect(txs.map((t) => t[0])).toEqual(txs.map((_, idx) => idx + 1));

					const txSet = new Set(txs.map((t) => t[0]));
					for (const fact of facts) {
						expect(fact).toHaveLength(5);
						expect(typeof fact[1]).toBe('string');
						expect(fact[4] === 'add' || fact[4] === 'retract').toBe(true);
						expect(Number.isInteger(fact[3])).toBe(true);
						expect(fact[3]).toBeGreaterThanOrEqual(1);
						expect(txSet.has(fact[3])).toBe(true);
					}

					// Facts are appended in non-decreasing transaction order.
					for (let i = 1; i < facts.length; i += 1) {
						expect(facts[i][3]).toBeGreaterThanOrEqual(facts[i - 1][3]);
					}

					// One transaction per operation.
					expect(facts).toHaveLength(ops.length);
					expect(txs).toHaveLength(ops.length);
				}
			)
		);
	});
});

describe('property: total behavior with arbitrary values', () => {
	it('accepts arbitrary values and always returns coherent reads', () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						eid: EID_ARB,
						attr: fc.constantFrom('a', 'b', 'c'),
						value: fc.oneof(
							fc.integer(),
							fc.string({ maxLength: 6 }),
							fc.boolean(),
							fc.constant(null),
							fc.constant([1, 2])
						)
					}),
					{ minLength: 0, maxLength: 40 }
				),
				(ops) => {
					const db = createDatabase();
					for (const op of ops) {
						db.add(op.eid, op.attr, op.value);
					}

					expect(db.getFacts()).toHaveLength(ops.length);
					for (const op of ops) {
						const entity = db.entity(op.eid);
						expect(entity === null || typeof entity === 'object').toBe(true);
					}

					// Reads never throw, regardless of stored value shapes.
					expect(() => db.find({ a: 1 })).not.toThrow();
					expect(() => db.query({ find: ['?e'], where: [['?e', 'a', 1]] })).not.toThrow();
				}
			)
		);
	});
});

describe('property: determinism', () => {
	it('produces identical fact logs for identical operation sequences', () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						kind: fc.constantFrom('add', 'retract'),
						eid: fc.integer({ min: 0, max: 5 }),
						attr: fc.constantFrom('a', 'b'),
						value: fc.integer()
					}),
					{ minLength: 0, maxLength: 40 }
				),
				(ops) => {
					const run = () => {
						const db = createDatabase();
						for (const op of ops) {
							if (op.kind === 'add') {
								db.add(op.eid, op.attr, op.value);
							} else {
								db.retract(op.eid, op.attr, op.value);
							}
						}
						return db.getFacts();
					};

					expect(run()).toEqual(run());
				}
			)
		);
	});
});

// Mirror of the engine's valueKey (see core/src/index.ts).
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

describe('property: AVET index consistency', () => {
	it('getFactsByAttributeValue returns exactly the facts sharing the canonical value key', () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						eid: fc.integer({ min: 0, max: 5 }),
						attr: fc.constantFrom('a', 'b'),
						value: fc.oneof(fc.integer(), fc.string({ maxLength: 6 }), fc.boolean(), fc.constant(null))
					}),
					{ minLength: 1, maxLength: 30 }
				),
				(ops) => {
					const db = createDatabase();
					const written: Array<[string, unknown]> = [];
					for (const op of ops) {
						db.add(op.eid, op.attr, op.value);
						written.push([op.attr, op.value]);
					}

					for (const [attr, value] of written) {
						const facts = db.getFactsByAttributeValue(attr, value);
						expect(facts.length).toBeGreaterThan(0);
						for (const f of facts) {
							expect(f[1]).toBe(attr);
							expect(valueKey(f[2])).toBe(valueKey(value));
						}
					}
				}
			)
		);
	});
});
