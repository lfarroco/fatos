/**
 * Shared test fixtures: a database snapshot containing schema facts (negative
 * eids), Date / bigint / ref / array values, and metadata, built through the
 * real engine.
 */

import { createDatabase, ref, serializeValue, type DatabaseSnapshot, type Fact } from '@fatos/core';

/** Builds a rich snapshot: 2 transactions, 8 facts, schema + typed values. */
export function makeRichSnapshot(): DatabaseSnapshot {
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
			['add', 1, 'user/born', new Date('1990-01-02T03:04:05.000Z')],
			['add', 1, 'user/balance', 10n],
			['add', 1, 'user/tags', ['a', 'b']],
			['add', 1, 'user/friend', ref(2)]
		],
		{ source: 'fixture' }
	);
	db.transact([['add', 2, 'user/name', 'Bob']], { source: 'fixture', count: 2 });

	return { facts: db.getFacts(), transactions: db.getTransactions() };
}

/** Maps facts to a JSON-comparable form (Date/bigint/ref values tagged). */
export function comparableFacts(facts: readonly Fact[]): unknown[] {
	return facts.map((fact) => [fact[0], fact[1], serializeValue(fact[2]), fact[3], fact[4]]);
}
