/**
 * Unit tests: schema declarations, value/type validation, cardinality validation,
 * and schema inspection.
 */

import { describe, it, expect } from 'vitest';
import { createDatabase } from './index';

describe('schema declarations', () => {
	it('stores schema as facts with negative entity ids', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/name', valueType: 'string', cardinality: 'one' }]);
		expect(db.getFactsByAttribute('db/ident')).toHaveLength(1);
		expect(db.getFactsByAttribute('db/valueType')[0]?.[2]).toBe('string');
		expect(db.getFactsByAttribute('db/cardinality')[0]?.[2]).toBe('one');
		const schemaEid = db.getFactsByAttribute('db/ident')[0]?.[0];
		expect(typeof schemaEid).toBe('number');
		expect((schemaEid as number) < 0).toBe(true);
	});

	it('declaring the same schema again commits no new facts (but still a transaction)', () => {
		const db = createDatabase();
		db.transact([{ ident: 'a/x', valueType: 'string', cardinality: 'one' }]);
		const result = db.transact([{ ident: 'a/x', valueType: 'string', cardinality: 'one' }]);
		expect(result).toEqual([]);
		expect(db.getFacts()).toHaveLength(3);
		expect(db.getTransactions()).toHaveLength(2); // pinned current behavior
	});

	it('rejects conflicting re-declarations', () => {
		const db = createDatabase();
		db.transact([{ ident: 'a/x', valueType: 'string', cardinality: 'one' }]);
		expect(() => db.transact([{ ident: 'a/x', valueType: 'number', cardinality: 'one' }])).toThrow(
			/Schema conflict/
		);
	});

	it('exposes schema via getSchema and getSchemas', () => {
		const db = createDatabase();
		db.transact([
			{ ident: 'user/tags', valueType: 'string', cardinality: 'many' },
			{ ident: 'user/age', valueType: 'number', cardinality: 'one' }
		]);
		expect(db.getSchema('user/age')).toEqual({
			eid: expect.any(Number),
			ident: 'user/age',
			valueType: 'number',
			cardinality: 'one'
		});
		expect(db.getSchema('missing')).toBeNull();
		expect(db.getSchemas().map((s) => s.ident)).toEqual(['user/age', 'user/tags']);
	});
});

describe('value type validation', () => {
	it('enforces declared value types', () => {
		const db = createDatabase();
		db.transact([
			{ ident: 'v/str', valueType: 'string', cardinality: 'one' },
			{ ident: 'v/num', valueType: 'number', cardinality: 'one' },
			{ ident: 'v/bool', valueType: 'boolean', cardinality: 'one' },
			{ ident: 'v/nul', valueType: 'null', cardinality: 'one' }
		]);
		expect(() => db.add(1, 'v/str', 5)).toThrow(/Invalid value type/);
		expect(() => db.add(1, 'v/num', 'x')).toThrow(/Invalid value type/);
		expect(() => db.add(1, 'v/bool', 'true')).toThrow(/Invalid value type/);
		expect(() => db.add(1, 'v/nul', null)).not.toThrow();
		expect(() => db.add(1, 'v/nul', 'x')).toThrow(/Invalid value type/);
	});

	it('unknown value type accepts anything supported', () => {
		const db = createDatabase();
		db.transact([{ ident: 'v/any', valueType: 'unknown', cardinality: 'one' }]);
		const values = ['x', 1, true, null, new Date(0), 10n, [1, 2]];
		for (let i = 0; i < values.length; i += 1) {
			expect(() => db.add(i + 1, 'v/any', values[i])).not.toThrow();
		}

		// opaque objects are rejected by the engine regardless of schema
		expect(() => db.add(99, 'v/any', { nested: true })).toThrow(/opaque objects/);
	});
});

describe('cardinality one validation', () => {
	it('allows the same value and rejects a different one', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/name', valueType: 'string', cardinality: 'one' }]);
		db.add(1, 'user/name', 'Alice');
		expect(() => db.add(1, 'user/name', 'Alice')).not.toThrow();
		expect(() => db.add(1, 'user/name', 'Bob')).toThrow(/Cardinality conflict/);
	});

	it('allows retract-then-re-add to change a value', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/name', valueType: 'string', cardinality: 'one' }]);
		db.transact([
			['retract', 1, 'user/name', 'Alice'],
			['add', 1, 'user/name', 'Bob']
		]);
		expect(db.entity(1)).toEqual({ id: 1, 'user/name': 'Bob' });
	});
});

describe('known limitations (pinned current behavior)', () => {
	it('does not validate attributes declared in the same transaction (see design/02, P0)', () => {
		const db = createDatabase();
		// KNOWN LIMITATION: schema facts are applied after validation, so an attribute
		// declared and written in the same transaction bypasses valueType checking.
		const facts = db.transact([
			{ ident: 'user/age', valueType: 'number', cardinality: 'one' },
			['add', 1, 'user/age', 'not-a-number']
		]);
		expect(facts).toHaveLength(4); // 3 schema facts + the invalid value fact
		expect(db.entity(1)).toEqual({ id: 1, 'user/age': 'not-a-number' });
	});
});
