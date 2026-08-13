/**
 * Unit tests: find and datalog query behavior, including tx-scoped reads.
 */

import { describe, it, expect } from 'vitest';
import { createDatabase } from './index';

describe('find', () => {
	it('matches entities by exact attribute values', () => {
		const db = createDatabase();
		db.transact([
			['add', 1, 'role', 'admin'],
			['add', 1, 'name', 'Alice'],
			['add', 2, 'role', 'admin'],
			['add', 3, 'role', 'viewer']
		]);
		expect(db.find({ role: 'admin' })).toEqual([
			{ id: 1, role: 'admin', name: 'Alice' },
			{ id: 2, role: 'admin' }
		]);
	});

	it('ANDs multiple criteria', () => {
		const db = createDatabase();
		db.transact([
			['add', 1, 'role', 'admin'],
			['add', 1, 'active', true],
			['add', 2, 'role', 'admin'],
			['add', 2, 'active', false]
		]);
		expect(db.find({ role: 'admin', active: true })).toEqual([{ id: 1, role: 'admin', active: true }]);
	});

	it('returns [] when nothing matches and skips entities without the attribute', () => {
		const db = createDatabase();
		db.add(1, 'a', 1);
		db.add(2, 'b', 1);
		expect(db.find({ a: 1 })).toEqual([{ id: 1, a: 1 }]);
		expect(db.find({ c: 99 })).toEqual([]);
	});

	it('supports tx-scoped reads', () => {
		const db = createDatabase();
		db.add(1, 'type', 'user'); // tx 1
		db.add(2, 'type', 'user'); // tx 2
		db.retract(2, 'type', 'user'); // tx 3
		expect(db.find({ type: 'user' }, 2)).toEqual([
			{ id: 1, type: 'user' },
			{ id: 2, type: 'user' }
		]);
		expect(db.find({ type: 'user' })).toEqual([{ id: 1, type: 'user' }]);
	});

	it('does not match cardinality-many values (known limitation, see design/02)', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/tags', valueType: 'string', cardinality: 'many' }]);
		db.add(1, 'user/tags', 'ts');
		// KNOWN LIMITATION: find compares criteria via Object.is against the whole array,
		// so scalar criteria never match many-valued attributes.
		expect(db.find({ 'user/tags': 'ts' })).toEqual([]);
	});
});

describe('datalog query', () => {
	it('returns matching entities as rows', () => {
		const db = createDatabase();
		db.transact([
			['add', 1, 'type', 'user'],
			['add', 2, 'type', 'user'],
			['add', 3, 'type', 'admin']
		]);
		expect(db.query({ find: ['?e'], where: [['?e', 'type', 'user']] })).toEqual([[1], [2]]);
	});

	it('joins multiple clauses and projects variables', () => {
		const db = createDatabase();
		db.transact([
			['add', 1, 'type', 'user'],
			['add', 1, 'name', 'Alice'],
			['add', 2, 'type', 'user'],
			['add', 2, 'name', 'Bob']
		]);
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

	it('deduplicates duplicate result rows', () => {
		const db = createDatabase();
		db.transact([
			['add', 1, 'type', 'user'],
			['add', 1, 'name', 'Alice'],
			['add', 2, 'type', 'user'],
			['add', 2, 'name', 'Alice']
		]);
		expect(
			db.query({
				find: ['?name'],
				where: [
					['?e', 'type', 'user'],
					['?e', 'name', '?name']
				]
			})
		).toEqual([['Alice']]);
	});

	it('supports constant (non-variable) terms in find and where', () => {
		const db = createDatabase();
		db.transact([
			['add', 1, 'type', 'user'],
			['add', 1, 'name', 'Alice']
		]);
		expect(
			db.query({
				find: ['?e', 'user'],
				where: [
					['?e', 'type', 'user'],
					['?e', 'name', '?name']
				]
			})
		).toEqual([[1, 'user']]);
	});

	it('matches members of cardinality-many attributes', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/tags', valueType: 'string', cardinality: 'many' }]);
		db.transact([
			['add', 1, 'user/tags', 'ts'],
			['add', 1, 'user/tags', 'db'],
			['add', 2, 'user/tags', 'ts']
		]);
		expect(
			db.query({
				find: ['?e'],
				where: [['?e', 'user/tags', 'ts']]
			})
		).toEqual([[1], [2]]);
	});

	it('supports tx-scoped queries', () => {
		const db = createDatabase();
		db.add(1, 'type', 'user');
		db.add(1, 'name', 'Alice');
		db.retract(1, 'type', 'user');
		expect(db.query({ find: ['?e'], where: [['?e', 'type', 'user']] }, 2)).toEqual([[1]]);
		expect(db.query({ find: ['?e'], where: [['?e', 'type', 'user']] })).toEqual([]);
	});

	it('works with string entity ids', () => {
		const db = createDatabase();
		db.add(['s1', 'type', 'user']);
		expect(db.query({ find: ['?e'], where: [['?e', 'type', 'user']] })).toEqual([['s1']]);
	});
});
