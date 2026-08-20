import type { InsertMap, TransactionEntry } from '@fatos/core';
import type { FatosServer } from '@fatos/server';

/**
 * Schema + starter cards for LiveBoard. Column membership and card order are
 * plain facts (`card/column`, `card/order`), so moving a card is just a
 * retract+add transaction that every connected tab replays. Data is authored
 * as object maps (`server.insert`), the design/02 primary form.
 */
export const SCHEMA_ENTRIES: TransactionEntry[] = [
	{ ident: 'card/title', valueType: 'string', cardinality: 'one' },
	{ ident: 'card/column', valueType: 'string', cardinality: 'one' },
	{ ident: 'card/order', valueType: 'number', cardinality: 'one' }
];

export const SEED_MAPS: InsertMap[] = [
	{ id: 'card:1', 'card/title': 'Write niche verdict READMEs', 'card/column': 'todo', 'card/order': 0 },
	{ id: 'card:2', 'card/title': 'Wire file persistence to the servers', 'card/column': 'in-progress', 'card/order': 0 },
	{ id: 'card:3', 'card/title': 'Run the three demo apps', 'card/column': 'done', 'card/order': 0 }
];

/** Seeds the board only when it has no cards yet. */
export function seedIfEmpty(server: FatosServer): void {
	const rows = server.query({
		find: ['?e'],
		where: [['?e', 'card/column', '?column']]
	});
	if (rows.length > 0) {
		console.log('[liveboard] board already seeded — skipping');
		return;
	}

	server.transact(SCHEMA_ENTRIES, { source: 'liveboard:seed' });
	server.insert(SEED_MAPS, { source: 'liveboard:seed' });
	console.log(`[liveboard] seeded ${SCHEMA_ENTRIES.length} schema entries + ${SEED_MAPS.length} cards`);
}
