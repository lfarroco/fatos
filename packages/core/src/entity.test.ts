/**
 * Unit tests: entity state reconstruction from the fact log, including add/retract
 * semantics, value edge cases, cardinality-many behavior, and time travel.
 */

import { describe, it, expect } from 'vitest';
import { createDatabase } from './index';

describe('entity state', () => {
	it('rebuilds state from facts (last add wins for unconstrained attributes)', () => {
		const db = createDatabase();
		db.add(1, 'name', 'Alice');
		db.add(1, 'name', 'Alicia');
		db.add(1, 'age', 22);
		expect(db.entity(1)).toEqual({ id: 1, name: 'Alicia', age: 22 });
	});

	it('returns null for unknown entities and after full retraction', () => {
		const db = createDatabase();
		db.add(1, 'a', 'x');
		db.retract(1, 'a', 'x');
		expect(db.entity(1)).toBeNull();
		expect(db.entity(99)).toBeNull();
	});

	it('treats retracting a non-existent value as a no-op', () => {
		const db = createDatabase();
		db.add(1, 'a', 'x');
		db.retract(1, 'a', 'nope');
		expect(db.entity(1)).toEqual({ id: 1, a: 'x' });
	});

	it('keeps duplicate facts in the log while entity state stays last-wins', () => {
		const db = createDatabase();
		db.add(1, 'a', 'x');
		db.add(1, 'a', 'x');
		expect(db.getFacts()).toHaveLength(2);
		expect(db.entity(1)).toEqual({ id: 1, a: 'x' });
	});

	it('supports add -> retract -> re-add sequences', () => {
		const db = createDatabase();
		db.add(1, 'a', 'x');
		db.retract(1, 'a', 'x');
		db.add(1, 'a', 'y');
		expect(db.entity(1)).toEqual({ id: 1, a: 'y' });
	});

	it('round-trips opaque object and array values', () => {
		const db = createDatabase();
		const value = { nested: { list: [1, 2] } };
		db.add(1, 'payload', value);
		expect(db.entity(1)).toEqual({ id: 1, payload: value });
	});

	it('uses Object.is semantics: -0 and +0 are distinct, NaN equals NaN', () => {
		const db = createDatabase();
		db.add(1, 'n', 0);
		db.retract(1, 'n', -0); // Object.is(0, -0) === false -> no-op
		expect(db.entity(1)).toEqual({ id: 1, n: 0 });

		const db2 = createDatabase();
		db2.add(2, 'n', NaN);
		db2.retract(2, 'n', NaN); // Object.is(NaN, NaN) === true -> removes
		expect(db2.entity(2)).toBeNull();
	});

	it('returns id plus attributes with stable ordering', () => {
		const db = createDatabase();
		db.add(1, 'z', 1);
		db.add(1, 'a', 2);
		const entity = db.entity(1);
		expect(Object.keys(entity ?? {})).toEqual(['id', 'z', 'a']);
	});
});

describe('cardinality many', () => {
	it('accumulates values as a set and returns them as an array', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/tags', valueType: 'string', cardinality: 'many' }]);
		db.transact([
			['add', 1, 'user/tags', 'ts'],
			['add', 1, 'user/tags', 'db'],
			['add', 1, 'user/tags', 'ts'] // duplicate is deduped
		]);
		expect(db.entity(1)).toEqual({ id: 1, 'user/tags': ['ts', 'db'] });
	});

	it('removes a single value on retract and drops the attribute when empty', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/tags', valueType: 'string', cardinality: 'many' }]);
		db.transact([
			['add', 1, 'user/tags', 'a'],
			['add', 1, 'user/tags', 'b']
		]);
		db.retract(1, 'user/tags', 'a');
		expect(db.entity(1)).toEqual({ id: 1, 'user/tags': ['b'] });
		db.retract(1, 'user/tags', 'b');
		expect(db.entity(1)).toBeNull();
	});

	it('treats retracting a missing item as a no-op', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/tags', valueType: 'string', cardinality: 'many' }]);
		db.add(1, 'user/tags', 'a');
		db.retract(1, 'user/tags', 'missing');
		expect(db.entity(1)).toEqual({ id: 1, 'user/tags': ['a'] });
	});
});

describe('time travel', () => {
	it('reconstructs entity state as of a past transaction', () => {
		const db = createDatabase();
		db.add(1, 'name', 'Alice'); // tx 1
		db.add(1, 'age', 22); // tx 2
		db.retract(1, 'age', 22); // tx 3
		expect(db.entity(1, 1)).toEqual({ id: 1, name: 'Alice' });
		expect(db.entity(1, 2)).toEqual({ id: 1, name: 'Alice', age: 22 });
		expect(db.entity(1, 3)).toEqual({ id: 1, name: 'Alice' });
	});

	it('treats tx 0 as empty history and beyond-current as current', () => {
		const db = createDatabase();
		db.add(1, 'a', 'x');
		expect(db.entity(1, 0)).toBeNull();
		expect(db.entity(1, 999)).toEqual({ id: 1, a: 'x' });
	});
});
