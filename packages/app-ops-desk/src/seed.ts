import type { FatosServer } from '@fatos/server';
import type { InsertMap, TransactionEntry } from '@fatos/core';

/**
 * Schema and seed data for the Ops Desk demo.
 *
 * Facts are `[eid, attribute, value, tx, op]`; schema is also facts. String
 * entity ids are first-class, so the catalog uses stable ids ('item:cof').
 * `item/sku` and `order/number` are `unique: 'identity'`, so duplicate sku /
 * order numbers are rejected at the database layer — validation that a plain
 * app database only gets with a schema. Data is authored as object maps
 * (`server.insert`) — the design/02 primary form — and reconciles through
 * `server.merge` on re-seeds.
 */
export const SCHEMA_ENTRIES: TransactionEntry[] = [
	{ ident: 'item/sku', valueType: 'string', cardinality: 'one', unique: 'identity' },
	{ ident: 'item/name', valueType: 'string', cardinality: 'one' },
	{ ident: 'item/stock', valueType: 'number', cardinality: 'one' },
	{ ident: 'order/number', valueType: 'string', cardinality: 'one', unique: 'identity' },
	{ ident: 'order/item', valueType: 'string', cardinality: 'one' },
	{ ident: 'order/customer', valueType: 'string', cardinality: 'one' },
	{ ident: 'order/status', valueType: 'string', cardinality: 'one' }
];

export const SEED_MAPS: InsertMap[] = [
	{ id: 'item:cof', 'item/sku': 'COF-001', 'item/name': 'Coffee beans', 'item/stock': 12 },
	{ id: 'item:tea', 'item/sku': 'TEA-001', 'item/name': 'Loose-leaf tea', 'item/stock': 8 },
	{ id: 'item:mlk', 'item/sku': 'MLK-001', 'item/name': 'Oat milk', 'item/stock': 24 },
	{
		id: 'order:1001',
		'order/number': 'ORD-1001',
		'order/item': 'COF-001',
		'order/customer': 'Acme Corp',
		'order/status': 'placed'
	}
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

	server.transact(SCHEMA_ENTRIES, { source: 'ops-desk:seed' });
	server.insert(SEED_MAPS, { source: 'ops-desk:seed' });
	console.log(`[ops-desk] seeded ${SCHEMA_ENTRIES.length} schema entries + ${SEED_MAPS.length} entities`);
}
