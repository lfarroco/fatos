/**
 * Reactive client — subscribe to the fact store.
 *
 * Observers push only when their results actually change, so a UI stays in
 * sync with the database without any manual bookkeeping.
 */
import { createClient } from '@fatos/client';
import type { EntityState, QueryTerm, TransactionRecord } from '@fatos/client';
import { log, section } from './helpers';

export type ReactiveResult = {
	events: string[];
	afterUnsubscribe: number;
};

export function run(): ReactiveResult {
	section('Reactive client — queries that push updates');

	const client = createClient();
	const events: string[] = [];

	const stopAdmins = client.observe({ 'user/role': 'admin' }, (users: EntityState[]) => {
		events.push(`admins=${users.length}`);
	});
	const stopAlice = client.observeEntity(1, (entity: EntityState | null) => {
		events.push(`entity1=${entity === null ? 'none' : String(entity['user/name'])}`);
	});
	const stopActive = client.observeQuery(
		{ find: ['?e'], where: [['?e', 'user/active', true]] },
		(rows: QueryTerm[][]) => {
			events.push(`active=${rows.length}`);
		}
	);
	const stopTx = client.observeTransactions((transactions: readonly TransactionRecord[]) => {
		events.push(`transactions=${transactions.length}`);
	});

	log('observe', 'Four observers are registered; each fires with its initial snapshot');

	client.transact([
		['add', 1, 'user/name', 'Alice'],
		['add', 1, 'user/role', 'admin'],
		['add', 1, 'user/active', true]
	]);
	log('observe', 'After adding Alice (admin, active):');
	log('observe', events);

	client.transact([
		['add', 2, 'user/name', 'Bob'],
		['add', 2, 'user/role', 'viewer'],
		['add', 2, 'user/active', false]
	]);
	log('observe', 'After adding Bob (viewer, inactive) — only the transaction log changed:');
	log('observe', events);

	// Writing the same value again does not move any observed result.
	client.add(2, 'user/name', 'Bob');
	log('observe', 'After rewriting the same value — again only the log changed:');
	log('observe', events);

	stopAdmins();
	stopAlice();
	stopActive();
	stopTx();

	client.add(3, 'user/name', 'Carol');
	log('observe', `After unsubscribing and adding Carol, nothing fires (${events.length} events total)`);
	const afterUnsubscribe = events.length;

	return { events, afterUnsubscribe };
}
