/**
 * Unit tests: fact creation — add/retract/transact input forms, transactions,
 * atomicity, and metadata.
 */

import { describe, it, expect } from 'vitest';
import { createDatabase, type TransactionEntryInput } from './index';

describe('add', () => {
	it('returns a well-formed fact and commits exactly one transaction', () => {
		const db = createDatabase();
		expect(db.add(1, 'name', 'Alice')).toEqual([1, 'name', 'Alice', 1, 'add']);
		expect(db.getFacts()).toEqual([[1, 'name', 'Alice', 1, 'add']]);
		expect(db.getTransactions()).toEqual([[1, expect.any(Number), null]]);
	});

	it('accepts tuple input and applies values in call order', () => {
		const db = createDatabase();
		expect(db.add(['e1', 'name', 'Alice'])).toEqual(['e1', 'name', 'Alice', 1, 'add']);
		expect(db.add(['e1', 'name', 'Alicia'])).toEqual(['e1', 'name', 'Alicia', 2, 'add']);
	});

	it('supports string entity ids for add and retract', () => {
		const db = createDatabase();
		db.add('user:1', 'name', 'Alice');
		db.retract('user:1', 'name', 'Alice');
		expect(db.getFacts()).toEqual([
			['user:1', 'name', 'Alice', 1, 'add'],
			['user:1', 'name', 'Alice', 2, 'retract']
		]);
	});

	it('treats every add/retract call as its own transaction', () => {
		const db = createDatabase();
		db.add(1, 'a', 1);
		db.retract(1, 'a', 1);
		db.add(2, 'b', 2);
		expect(db.getTransactions().map((tx) => tx[0])).toEqual([1, 2, 3]);
	});
});

describe('transact', () => {
	it('groups multiple mutations into a single transaction', () => {
		const db = createDatabase();
		const facts = db.transact([
			['add', 1, 'type', 'user'],
			['add', 1, 'name', 'Alice'],
			['add', 2, 'type', 'admin']
		]);
		expect(facts).toEqual([
			[1, 'type', 'user', 1, 'add'],
			[1, 'name', 'Alice', 1, 'add'],
			[2, 'type', 'admin', 1, 'add']
		]);
		expect(db.getTransactions()).toHaveLength(1);
	});

	it('passes metadata through and defaults to null', () => {
		const db = createDatabase();
		db.transact([['add', 1, 'a', 1]], { source: 'test', seq: 7 });
		db.transact([['add', 1, 'b', 2]]);
		expect(db.getTransactions()).toEqual([
			[1, expect.any(Number), { source: 'test', seq: 7 }],
			[2, expect.any(Number), null]
		]);
	});

	it('treats plain tuples as adds', () => {
		const db = createDatabase();
		const facts = db.transact([
			['e1', 'name', 'Alice'],
			['e1', 'role', 'admin']
		]);
		expect(facts.map((f) => f[4])).toEqual(['add', 'add']);
	});

	it('returns [] and commits nothing for an empty input', () => {
		const db = createDatabase();
		expect(db.transact([])).toEqual([]);
		expect(db.getTransactions()).toHaveLength(0);
		expect(db.getFacts()).toHaveLength(0);
	});

	it('rejects malformed entries', () => {
		const db = createDatabase();
		expect(() => db.transact([['bogus', 1, 'a', 1]] as unknown as TransactionEntryInput[])).toThrow(
			/Invalid transaction entry format/
		);
	});

	it('is atomic: a failing mutation rolls back the whole batch', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/age', valueType: 'number', cardinality: 'one' }]);
		const factsBefore = db.getFacts().length;
		const txsBefore = db.getTransactions().length;

		expect(() =>
			db.transact([
				['add', 1, 'user/name', 'Alice'],
				['add', 1, 'user/age', 'not-a-number']
			])
		).toThrow(/Invalid value type/);

		expect(db.getFacts()).toHaveLength(factsBefore);
		expect(db.getTransactions()).toHaveLength(txsBefore);

		// tx ids continue where they left off
		expect(db.transact([['add', 2, 'user/name', 'Bob']])[0]?.[3]).toBe(txsBefore + 1);
	});

	it('is atomic for cardinality conflicts too', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/age', valueType: 'number', cardinality: 'one' }]);
		db.add(1, 'user/age', 30);
		const factsBefore = db.getFacts().length;
		expect(() =>
			db.transact([
				['add', 1, 'user/age', 31],
				['add', 2, 'x', 'y']
			])
		).toThrow(/Cardinality conflict/);
		expect(db.getFacts()).toHaveLength(factsBefore);
	});
});
