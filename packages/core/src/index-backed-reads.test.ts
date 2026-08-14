/**
 * Unit tests: index-backed read paths (P0).
 *
 * Verifies that entity()/find()/query()/activeValues() are served from the
 * EAVT/AEVT/AVET indexes (not a full fact scan), that result ordering stays
 * deterministic (commit order / insertion order), and that entity state is
 * Object.freeze-d per design/01.
 */

import { describe, it, expect } from 'vitest';
import { createDatabase } from './index';

describe('entity() builds state from the EAVT index', () => {
	it('returns null for unknown entities without scanning', () => {
		const db = createDatabase();
		db.transact([
			['add', 1, 'a', 'x'],
			['add', 2, 'a', 'y']
		]);
		expect(db.entity(1)).toEqual({ id: 1, a: 'x' });
		expect(db.entity(99)).toBeNull();
	});

	it('keeps attributes in insertion (first-fact) order across retracts', () => {
		const db = createDatabase();
		db.add(1, 'a', 1); // tx 1
		db.add(1, 'b', 2); // tx 2
		db.retract(1, 'a', 1); // tx 3
		db.add(1, 'c', 3); // tx 4

		const entity = db.entity(1);
		expect(entity).toEqual({ id: 1, b: 2, c: 3 });
		expect(Object.keys(entity ?? {})).toEqual(['id', 'b', 'c']);
	});

	it('reconstructs cardinality-many arrays in insertion order with re-adds moving to the end', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/tags', valueType: 'string', cardinality: 'many' }]);
		db.transact([
			['add', 1, 'user/tags', 'ts'],
			['add', 1, 'user/tags', 'db']
		]);
		db.retract(1, 'user/tags', 'ts');
		db.add(1, 'user/tags', 'ts');

		expect(db.entity(1)).toEqual({ id: 1, 'user/tags': ['db', 'ts'] });
	});
});

describe('find() and query() are index-backed and deterministic at scale', () => {
	function seed(db: ReturnType<typeof createDatabase>, count: number): void {
		const BATCH = 500;
		for (let start = 0; start < count; start += BATCH) {
			const mutations: Array<['add', number, string, unknown]> = [];
			for (let i = start; i < Math.min(start + BATCH, count); i += 1) {
				mutations.push(['add', i, 'type', i % 2 === 0 ? 'user' : 'admin']);
				mutations.push(['add', i, 'group', `g${i % 20}`]);
			}
			db.transact(mutations);
		}
	}

	it('find returns every match in commit (first-fact) order and is stable across calls', () => {
		const db = createDatabase();
		seed(db, 1500); // 3000 facts

		const first = db.find({ type: 'user' });
		expect(first).toHaveLength(750);
		expect(first[0]?.id).toBe(0);
		expect(first[1]?.id).toBe(2);
		expect(first[749]?.id).toBe(1498);
		// Order follows entity first-fact order, not id order.
		expect(first.map((entity) => entity.id as number)).toEqual(
			first.map((entity) => entity.id as number).slice().sort((a, b) => a - b)
		);
		expect(db.find({ type: 'user' })).toEqual(first);
	});

	it('query joins are complete, deduplicated, and repeatable over many facts', () => {
		const db = createDatabase();
		seed(db, 1500);

		const spec = {
			find: ['?e', '?g'],
			where: [
				['?e', 'type', 'user'],
				['?e', 'group', '?g']
			]
		} as const;
		const rows = db.query(spec);
		expect(rows).toHaveLength(750);
		expect(rows[0]).toEqual([0, 'g0']);
		expect(rows[1]).toEqual([2, 'g2']);
		expect(db.query(spec)).toEqual(rows);

		// A selective constant join narrows through AVET on both clauses. Users are
		// even ids, so group g4 (i % 20 === 4) selects 75 of the 750 users.
		const narrow = db.query({
			find: ['?e'],
			where: [
				['?e', 'type', 'user'],
				['?e', 'group', 'g4']
			]
		});
		expect(narrow).toHaveLength(75);
		for (const [eid] of narrow) {
			expect(eid).toBeTypeOf('number');
		}
	});

	it('orders find/query rows by entity first-fact order even when per-attribute order differs', () => {
		const db = createDatabase();
		// Entity 2's first fact ('b') precedes entity 1's, but entity 1's 'a'
		// fact precedes entity 2's. Rows must follow global first-fact order.
		db.transact([
			['add', 2, 'b', 2],
			['add', 1, 'a', 1],
			['add', 2, 'a', 1],
			['add', 1, 'b', 2]
		]);

		expect(db.find({ a: 1, b: 2 }).map((entity) => entity.id)).toEqual([2, 1]);
		expect(db.query({ find: ['?e'], where: [['?e', 'a', 1], ['?e', 'b', 2]] })).toEqual([[2], [1]]);
	});

	it('keeps facts grouped by transaction for multi-fact transactions', () => {
		const db = createDatabase();
		db.transact([
			['add', 5, 'type', 'user'],
			['add', 3, 'type', 'user'],
			['add', 7, 'type', 'user']
		]);
		db.add(1, 'type', 'user');

		expect(db.query({ find: ['?e'], where: [['?e', 'type', 'user']] })).toEqual([[5], [3], [7], [1]]);
	});

	it('expands cardinality-many values in the same order entity() reports', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/tags', valueType: 'string', cardinality: 'many' }]);
		db.transact([
			['add', 1, 'user/tags', 'ts'],
			['add', 1, 'user/tags', 'db']
		]);
		db.retract(1, 'user/tags', 'ts');
		db.add(1, 'user/tags', 'ts');

		expect(db.entity(1)['user/tags']).toEqual(['db', 'ts']);
		expect(db.query({ find: ['?t'], where: [['?e', 'user/tags', '?t']] })).toEqual([['db'], ['ts']]);
	});
});


describe('activeValues() (schema cardinality validation) reflects retractions', () => {
	it('cardinality-one: retracting the value lets a different value be added', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/name', valueType: 'string', cardinality: 'one' }]);
		db.add(1, 'user/name', 'Alice');
		expect(() => db.add(1, 'user/name', 'Bob')).toThrow(/Cardinality conflict/);

		db.retract(1, 'user/name', 'Alice');
		expect(() => db.add(1, 'user/name', 'Bob')).not.toThrow();
		expect(db.entity(1)).toEqual({ id: 1, 'user/name': 'Bob' });
	});

	it('cardinality-one: retracting a non-current value is a no-op', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/name', valueType: 'string', cardinality: 'one' }]);
		db.add(1, 'user/name', 'Alice');
		db.retract(1, 'user/name', 'Bob'); // no-op retract
		expect(() => db.add(1, 'user/name', 'Carol')).toThrow(/Cardinality conflict/);
	});

	it('cardinality-many: values are tracked across adds and retracts', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/tags', valueType: 'string', cardinality: 'many' }]);
		db.transact([
			['add', 1, 'user/tags', 'a'],
			['add', 1, 'user/tags', 'b']
		]);
		db.retract(1, 'user/tags', 'a');
		expect(() => db.add(1, 'user/tags', 'c')).not.toThrow();
		expect(() => db.add(1, 'user/tags', 'b')).not.toThrow(); // duplicates allowed for many
		expect(db.entity(1)).toEqual({ id: 1, 'user/tags': ['b', 'c'] });
	});
});

describe('entity state is frozen (design/01)', () => {
	it('entity() returns an Object.freeze-d object', () => {
		const db = createDatabase();
		db.transact([
			['add', 1, 'name', 'Alice'],
			['add', 1, 'age', 22]
		]);
		const entity = db.entity(1);
		expect(entity).not.toBeNull();
		expect(Object.isFrozen(entity)).toBe(true);
		expect(() => {
			entity.name = 'Alicia';
		}).toThrow(TypeError);
	});

	it('cardinality-many arrays are frozen too', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/tags', valueType: 'string', cardinality: 'many' }]);
		db.add(1, 'user/tags', 'ts');
		const entity = db.entity(1) as { id: number; 'user/tags': string[] };
		expect(Object.isFrozen(entity['user/tags'])).toBe(true);
		expect(() => {
			entity['user/tags'].push('db');
		}).toThrow(TypeError);
	});

	it('find() results are frozen as well', () => {
		const db = createDatabase();
		db.add(1, 'type', 'user');
		const [entity] = db.find({ type: 'user' });
		expect(Object.isFrozen(entity)).toBe(true);
	});

	it('consumers can still get a mutable copy via structuredClone', () => {
		const db = createDatabase();
		db.transact([
			['add', 1, 'name', 'Alice'],
			['add', 1, 'tags', 'a']
		]);
		const copy = structuredClone(db.entity(1)) as { id: number; name: string; tags: string };
		copy.name = 'Alicia';
		expect(copy.name).toBe('Alicia');
		expect(db.entity(1)).toEqual({ id: 1, name: 'Alice', tags: 'a' });
	});
});
