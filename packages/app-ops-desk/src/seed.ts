import type { FatosServer } from '@fatos/server';
import type { TransactionEntry } from '@fatos/core';

/**
 * Schema and seed data for the Ops Desk demo.
 *
 * Facts are `[eid, attribute, value, tx, op]`; schema is also facts. String
 * entity ids are first-class, so the catalog uses stable ids ('item:cof').
 * `item/sku` and `order/number` are `unique: 'identity'`, so duplicate sku /
 * order numbers are rejected at the database layer — validation that a plain
 * app database only gets with a schema.
 */
export const SEED_ENTRIES: TransactionEntry[] = [
	{ ident: 'item/sku', valueType: 'string', cardinality: 'one', unique: 'identity' },
	{ ident: 'item/name', valueType: 'string', cardinality: 'one' },
	{ ident: 'item/stock', valueType: 'number', cardinality: 'one' },
	{ ident: 'order/number', valueType: 'string', cardinality: 'one', unique: 'identity' },
	{ ident: 'order/item', valueType: 'string', cardinality: 'one' },
	{ ident: 'order/customer', valueType: 'string', cardinality: 'one' },
	{ ident: 'order/status', valueType: 'string', cardinality: 'one' },
	['add', 'item:cof', 'item/sku', 'COF-001'],
	['add', 'item:cof', 'item/name', 'Coffee beans'],
	['add', 'item:cof', 'item/stock', 12],
	['add', 'item:tea', 'item/sku', 'TEA-001'],
	['add', 'item:tea', 'item/name', 'Loose-leaf tea'],
	['add', 'item:tea', 'item/stock', 8],
	['add', 'item:mlk', 'item/sku', 'MLK-001'],
	['add', 'item:mlk', 'item/name', 'Oat milk'],
	['add', 'item:mlk', 'item/stock', 24],
	['add', 'order:1001', 'order/number', 'ORD-1001'],
	['add', 'order:1001', 'order/item', 'COF-001'],
	['add', 'order:1001', 'order/customer', 'Acme Corp'],
	['add', 'order:1001', 'order/status', 'placed']
];

/** Seeds the catalog + starter order only when the store has no items yet. */
export function seedIfEmpty(server: FatosServer): void {
	const rows = server.query({
		find: ['?e'],
		where: [['?e', 'item/sku', '?sku']]
	});
	if (rows.length > 0) {
		console.log('[ops-desk] store already seeded — skipping');
		return;
	}

	server.transact(SEED_ENTRIES, { source: 'ops-desk:seed' });
	console.log(`[ops-desk] seeded ${SEED_ENTRIES.length} entries (schema + catalog + one order)`);
}
