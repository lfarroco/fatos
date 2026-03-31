/**
 * Core database engine tests
 */

import { describe, it, expect } from 'vitest';
import { createDatabase, version } from './index';

describe('@fatos/core', () => {
	it('should export version', () => {
		expect(version).toBeDefined();
	});

	it('stores immutable facts with monotonic transaction ids', () => {
		const db = createDatabase();

		const first = db.add(1, 'name', 'Alice');
		const second = db.add(1, 'age', 22);
		const third = db.retract(1, 'age', 22);

		expect(first).toEqual([1, 'name', 'Alice', 1, 'add']);
		expect(second).toEqual([1, 'age', 22, 2, 'add']);
		expect(third).toEqual([1, 'age', 22, 3, 'retract']);
		expect(db.getFacts()).toEqual([first, second, third]);
		expect(db.getTransactions()).toEqual([
			[1, expect.any(Number), null],
			[2, expect.any(Number), null],
			[3, expect.any(Number), null]
		]);
	});

	it('supports ergonomic add tuple and string entity ids', () => {
		const db = createDatabase();

		const fact = db.add(['eid1', 'name', 'Alice']);
		expect(fact).toEqual(['eid1', 'name', 'Alice', 1, 'add']);
		expect(db.entity('eid1')).toEqual({ id: 'eid1', name: 'Alice' });
	});

	it('builds entity state from add/retract facts', () => {
		const db = createDatabase();
		db.add(1, 'name', 'Alice');
		db.add(1, 'age', 22);
		db.retract(1, 'age', 22);
		db.add(1, 'role', 'admin');

		expect(db.entity(1)).toEqual({ id: 1, name: 'Alice', role: 'admin' });
		expect(db.entity(99)).toBeNull();
	});

	it('supports tx-limited entity snapshots and simple find', () => {
		const db = createDatabase();
		db.add(1, 'type', 'user');
		db.add(1, 'name', 'Alice');
		db.add(2, 'type', 'user');
		db.add(2, 'name', 'Bob');
		db.retract(2, 'type', 'user');

		expect(db.entity(2, 4)).toEqual({ id: 2, type: 'user', name: 'Bob' });
		expect(db.entity(2, 5)).toEqual({ id: 2, name: 'Bob' });

		expect(db.find({ type: 'user' })).toEqual([{ id: 1, type: 'user', name: 'Alice' }]);
		expect(db.find({ type: 'user' }, 4)).toEqual([
			{ id: 1, type: 'user', name: 'Alice' },
			{ id: 2, type: 'user', name: 'Bob' }
		]);
	});

	it('supports grouped transactions with metadata', () => {
		const db = createDatabase();

		const facts = db.transact(
			[
				['add', 10, 'type', 'user'],
				['add', 10, 'name', 'Charlie'],
				['add', 11, 'type', 'user']
			],
			{ source: 'test' }
		);

		expect(facts).toEqual([
			[10, 'type', 'user', 1, 'add'],
			[10, 'name', 'Charlie', 1, 'add'],
			[11, 'type', 'user', 1, 'add']
		]);
		expect(db.getTransactions()).toEqual([[1, expect.any(Number), { source: 'test' }]]);
		expect(db.find({ type: 'user' })).toEqual([
			{ id: 10, type: 'user', name: 'Charlie' },
			{ id: 11, type: 'user' }
		]);
	});

	it('supports transact with ergonomic tuple list', () => {
		const db = createDatabase();

		const facts = db.transact([
			['eid1', 'name', 'Alice'],
			['eid1', 'role', 'admin']
		]);

		expect(facts).toEqual([
			['eid1', 'name', 'Alice', 1, 'add'],
			['eid1', 'role', 'admin', 1, 'add']
		]);
		expect(db.entity('eid1')).toEqual({ id: 'eid1', name: 'Alice', role: 'admin' });
	});

	it('provides indexed fact lookups through EAVT, AEVT, and AVET', () => {
		const db = createDatabase();
		db.transact([
			['add', 1, 'type', 'user'],
			['add', 1, 'age', 22],
			['add', 2, 'type', 'user'],
			['add', 2, 'age', 30],
			['add', 3, 'type', 'admin']
		]);

		expect(db.getFactsByEntityAttribute(1, 'age')).toEqual([[1, 'age', 22, 1, 'add']]);
		expect(db.getFactsByAttribute('type')).toEqual([
			[1, 'type', 'user', 1, 'add'],
			[2, 'type', 'user', 1, 'add'],
			[3, 'type', 'admin', 1, 'add']
		]);
		expect(db.getFactsByAttributeValue('type', 'user')).toEqual([
			[1, 'type', 'user', 1, 'add'],
			[2, 'type', 'user', 1, 'add']
		]);
	});

	it('supports datalog-style queries with joins', () => {
		const db = createDatabase();
		db.transact([
			['add', 1, 'type', 'user'],
			['add', 1, 'name', 'Alice'],
			['add', 2, 'type', 'user'],
			['add', 2, 'name', 'Bob'],
			['add', 3, 'type', 'admin'],
			['add', 3, 'name', 'Root']
		]);

		expect(
			db.query({
				find: ['?e'],
				where: [['?e', 'type', 'user']]
			})
		).toEqual([[1], [2]]);

		expect(
			db.query({
				find: ['?name'],
				where: [
					['?e', 'type', 'user'],
					['?e', 'name', '?name']
				]
			})
		).toEqual([['Alice'], ['Bob']]);
	});

	it('evaluates queries against transaction snapshots', () => {
		const db = createDatabase();
		db.add(1, 'type', 'user');
		db.add(1, 'name', 'Alice');
		db.retract(1, 'type', 'user');

		expect(
			db.query(
				{
					find: ['?e'],
					where: [['?e', 'type', 'user']]
				},
				2
			)
		).toEqual([[1]]);

		expect(
			db.query({
				find: ['?e'],
				where: [['?e', 'type', 'user']]
			})
		).toEqual([]);
	});

	it('declares schema using facts via object transact input', () => {
		const db = createDatabase();

		db.transact([
			{
				ident: 'user/name',
				valueType: 'string',
				cardinality: 'one'
			}
		]);

		const schemaFacts = db.getFactsByAttribute('db/ident');
		expect(schemaFacts).toHaveLength(1);
		expect(schemaFacts[0]?.[2]).toBe('user/name');
		expect(db.getFactsByAttribute('db/valueType')[0]?.[2]).toBe('string');
		expect(db.getFactsByAttribute('db/cardinality')[0]?.[2]).toBe('one');
	});

	it('supports cardinality many collection attributes', () => {
		const db = createDatabase();
		db.transact([
			{ ident: 'user/tags', valueType: 'string', cardinality: 'many' }
		]);

		db.transact([
			['add', 42, 'user/tags', 'typescript'],
			['add', 42, 'user/tags', 'datomic']
		]);

		expect(db.entity(42)).toEqual({ id: 42, 'user/tags': ['typescript', 'datomic'] });
		expect(
			db.query({
				find: ['?e'],
				where: [['?e', 'user/tags', 'datomic']]
			})
		).toEqual([[42]]);

		db.retract(42, 'user/tags', 'datomic');
		expect(db.entity(42)).toEqual({ id: 42, 'user/tags': ['typescript'] });
	});

	it('validates valueType and cardinality one constraints from schema', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/age', valueType: 'number', cardinality: 'one' }]);

		db.add(7, 'user/age', 33);
		expect(() => db.add(7, 'user/age', 'thirty-three')).toThrow(/Invalid value type/);
		expect(() => db.add(7, 'user/age', 34)).toThrow(/Cardinality conflict/);
	});

	it('exposes schema by ident', () => {
		const db = createDatabase();
		db.transact([
			{ ident: 'user/name', valueType: 'string', cardinality: 'one' }
		]);

		expect(db.getSchema('user/name')).toEqual({
			eid: expect.any(Number),
			ident: 'user/name',
			valueType: 'string',
			cardinality: 'one'
		});
		expect(db.getSchema('missing/attr')).toBeNull();
	});

	it('lists all schemas sorted by ident', () => {
		const db = createDatabase();
		db.transact([
			{ ident: 'user/tags', valueType: 'string', cardinality: 'many' },
			{ ident: 'user/age', valueType: 'number', cardinality: 'one' }
		]);

		expect(db.getSchemas()).toEqual([
			{
				eid: expect.any(Number),
				ident: 'user/age',
				valueType: 'number',
				cardinality: 'one'
			},
			{
				eid: expect.any(Number),
				ident: 'user/tags',
				valueType: 'string',
				cardinality: 'many'
			}
		]);
	});
});
