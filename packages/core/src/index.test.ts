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
});
