/**
 * Time travel — temporal queries and audit trails.
 *
 * Because facts are append-only, every past state can be reconstructed from
 * the fact log, and the transaction history doubles as an audit trail.
 */
import { createClient } from '@fatos/client';
import type { EntityState, Fact, TransactionRecord } from '@fatos/client';
import { log, section } from './helpers';

export type TimeTravelResult = {
	history: readonly Fact[];
	auditLog: readonly TransactionRecord[];
	atCreated: EntityState | null;
	atShipped: EntityState | null;
	atDelivered: EntityState | null;
	now: EntityState | null;
};

export function run(): TimeTravelResult {
	section('Time travel — reconstruct any past state from the fact log');

	const client = createClient();

	log('write', 'An order is placed, shipped, and delivered (one change per transaction)');
	client.transact(
		[
			{ ident: 'order/item', valueType: 'string', cardinality: 'one' },
			{ ident: 'order/status', valueType: 'string', cardinality: 'one' }
		],
		{ source: 'seed' }
	);
	client.transact(
		[
			['add', 1, 'order/item', 'coffee'],
			['add', 1, 'order/status', 'placed']
		],
		{ source: 'customer' }
	);
	client.transact([['retract', 1, 'order/status', 'placed']], { source: 'warehouse' });
	client.transact([['add', 1, 'order/status', 'shipped']], { source: 'warehouse' });
	client.transact([['retract', 1, 'order/status', 'shipped']], { source: 'courier' });
	client.transact([['add', 1, 'order/status', 'delivered']], { source: 'courier' });

	const auditLog = client.getTransactions();
	log('audit', `Audit log (${auditLog.length} transactions): ${JSON.stringify(auditLog)}`);

	const atCreated = client.atTransaction(2).entity(1);
	const atShipped = client.atTransaction(4).entity(1);
	const atDelivered = client.atTransaction(6).entity(1);
	const now = client.entity(1);
	log('time-travel', `After "placed":    ${JSON.stringify(atCreated)}`);
	log('time-travel', `After "shipped":   ${JSON.stringify(atShipped)}`);
	log('time-travel', `After "delivered": ${JSON.stringify(atDelivered)}`);
	log('time-travel', `Current state:     ${JSON.stringify(now)}`);

	const history = client.getFactsByEntity(1);
	log('audit', `Every fact ever written about order 1 (${history.length} facts): ${JSON.stringify(history)}`);

	return { history, auditLog, atCreated, atShipped, atDelivered, now };
}
