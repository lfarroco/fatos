/**
 * Basic usage — the core database API.
 *
 * Covers: creating a database, adding and retracting immutable facts, atomic
 * transactions with metadata, ergonomic tuples, string entity ids, entity
 * reads, criteria-based finds, and the index-backed fact lookups.
 */
import { createDatabase } from '@fatos/core';
import type { Fact, FactDatabase, TransactionRecord } from '@fatos/core';
import { log, section } from './helpers';

type EntityState = ReturnType<FactDatabase['entity']>;

export type BasicUsageResult = {
	facts: readonly Fact[];
	transactions: readonly TransactionRecord[];
	alice: EntityState;
	admins: EntityState[];
	stringEntity: EntityState;
	byAttribute: readonly Fact[];
	byValue: readonly Fact[];
	byEntityAttribute: readonly Fact[];
};

export function run(): BasicUsageResult {
	section('Basic usage — facts, transactions, and reads');

	const db = createDatabase();

	log('write', 'Add facts one at a time (each add commits its own transaction)');
	db.add(1, 'user/name', 'Alice');
	db.add([1, 'user/role', 'admin']); // ergonomic (eid, attribute, value) tuple
	db.add(['user:2', 'user/name', 'Bob']); // string entity ids work too

	log('write', 'Write several facts atomically in one transaction');
	db.transact(
		[
			['add', 1, 'user/active', true],
			['add', 2, 'user/active', true],
			['add', 'user:2', 'user/role', 'viewer']
		],
		{ source: 'seed' }
	);

	log('write', 'Retract a fact — nothing is overwritten, the history is kept');
	db.retract(['user:2', 'user/role', 'viewer']);

	const alice = db.entity(1);
	log('read', `Entity 1: ${JSON.stringify(alice)}`);

	const admins = db.find({ 'user/role': 'admin' });
	log('read', `Find all admins: ${JSON.stringify(admins)}`);

	const stringEntity = db.entity('user:2');
	log('read', `String entity user:2: ${JSON.stringify(stringEntity)}`);

	// Index-backed lookups: EAVT, AEVT, and AVET under the hood.
	const byAttribute = db.getFactsByAttribute('user/role');
	const byValue = db.getFactsByAttributeValue('user/active', true);
	const byEntityAttribute = db.getFactsByEntityAttribute(1, 'user/name');
	log('indexes', `Facts for attribute "user/role": ${JSON.stringify(byAttribute)}`);
	log('indexes', `Facts where "user/active" = true: ${JSON.stringify(byValue)}`);
	log('indexes', `Facts for entity 1 / "user/name": ${JSON.stringify(byEntityAttribute)}`);

	const facts = db.getFacts();
	const transactions = db.getTransactions();
	log('audit', `Append-only fact log (${facts.length} facts)`);
	log('audit', `Transaction history (${transactions.length} transactions): ${JSON.stringify(transactions)}`);

	return { facts, transactions, alice, admins, stringEntity, byAttribute, byValue, byEntityAttribute };
}

