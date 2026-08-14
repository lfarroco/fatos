/**
 * restore() tests — snapshot replay must rebuild an identical database,
 * including schema state (negative schema eids), tx numbering, and indexes.
 */

import { describe, it, expect } from 'vitest';
import { createDatabase, ref, serializeValue, type Fact } from './index';

/** Maps facts to a JSON-comparable form (Date/bigint/ref values tagged). */
function comparableFacts(facts: readonly Fact[]): unknown[] {
	return facts.map((fact) => [fact[0], fact[1], serializeValue(fact[2]), fact[3], fact[4]]);
}

describe('FactDatabase.restore', () => {
	it('replays a snapshot so the restored database matches the original', () => {
		const db = createDatabase();
		db.transact([
			{ ident: 'user/name', valueType: 'string', cardinality: 'one' },
			{ ident: 'user/born', valueType: 'date', cardinality: 'one' },
			{ ident: 'user/balance', valueType: 'bigint', cardinality: 'one' },
			{ ident: 'user/tags', valueType: 'unknown', cardinality: 'many' }
		]);
		db.transact(
			[
				['add', 1, 'user/name', 'Alice'],
				['add', 1, 'user/born', new Date('1990-01-02T03:04:05Z')],
				['add', 1, 'user/balance', 10n],
				['add', 1, 'user/tags', ['a', 'b']],
				['add', 1, 'user/friend', ref(2)]
			],
			{ source: 'restore-test' }
		);
		db.transact([['add', 2, 'user/name', 'Bob']]);

		const restored = createDatabase();
		restored.restore({ facts: db.getFacts(), transactions: db.getTransactions() });

		expect(comparableFacts(restored.getFacts())).toEqual(comparableFacts(db.getFacts()));
		expect(restored.getTransactions()).toEqual(db.getTransactions());
		expect(restored.getSchemas()).toEqual(db.getSchemas());
		expect(restored.entity(1)).toEqual(db.entity(1));
		expect(restored.entity(2)).toEqual(db.entity(2));
	});

	it('keeps tx numbering consistent so the next transaction continues after the last restored tx', () => {
		const db = createDatabase();
		db.transact([['add', 1, 'type', 'user']]);
		db.transact([['add', 2, 'type', 'admin']]);

		const restored = createDatabase();
		restored.restore({ facts: db.getFacts(), transactions: db.getTransactions() });

		const facts = restored.transact([['add', 3, 'type', 'guest']]);
		expect(facts[0]).toEqual([3, 'type', 'guest', 3, 'add']);
	});

	it('preserves unique constraint enforcement after restore', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/email', valueType: 'string', cardinality: 'one', unique: 'value' }]);
		db.transact([['add', 1, 'user/email', 'a@example.com']]);

		const restored = createDatabase();
		restored.restore({ facts: db.getFacts(), transactions: db.getTransactions() });

		expect(() => restored.transact([['add', 2, 'user/email', 'a@example.com']])).toThrow(
			/Unique constraint violation/
		);
	});

	it('rejects restoring into a non-empty database', () => {
		const db = createDatabase();
		db.transact([['add', 1, 'type', 'user']]);

		const snapshot = { facts: db.getFacts(), transactions: db.getTransactions() };
		expect(() => db.restore(snapshot)).toThrow(/only be called on an empty database/);
	});

	it('rejects snapshots with out-of-order facts or mismatched transactions', () => {
		const empty = createDatabase();

		expect(() =>
			empty.restore({
				facts: [
					[2, 'type', 'admin', 2, 'add'],
					[1, 'type', 'user', 1, 'add']
				],
				transactions: [
					[1, 1, null],
					[2, 2, null]
				]
			})
		).toThrow(/ordered by ascending tx/);

		expect(() =>
			empty.restore({
				facts: [[1, 'type', 'user', 1, 'add']],
				transactions: []
			})
		).toThrow(/no matching transaction record/);

		expect(() =>
			empty.restore({
				facts: [],
				transactions: [[1, 1, null]]
			})
		).toThrow(/has no facts/);
	});
});
