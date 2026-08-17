import type { TransactionEntry } from '@fatos/core';
import type { FatosServer } from '@fatos/server';

/**
 * Schema + starter cards for LiveBoard. Column membership and card order are
 * plain facts (`card/column`, `card/order`), so moving a card is just a
 * retract+add transaction that every connected tab replays.
 */
export const SEED_ENTRIES: TransactionEntry[] = [
	{ ident: 'card/title', valueType: 'string', cardinality: 'one' },
	{ ident: 'card/column', valueType: 'string', cardinality: 'one' },
	{ ident: 'card/order', valueType: 'number', cardinality: 'one' },
	['add', 'card:1', 'card/title', 'Write niche verdict READMEs'],
	['add', 'card:1', 'card/column', 'todo'],
	['add', 'card:1', 'card/order', 0],
	['add', 'card:2', 'card/title', 'Wire file persistence to the servers'],
	['add', 'card:2', 'card/column', 'in-progress'],
	['add', 'card:2', 'card/order', 0],
	['add', 'card:3', 'card/title', 'Run the three demo apps'],
	['add', 'card:3', 'card/column', 'done'],
	['add', 'card:3', 'card/order', 0]
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

	server.transact(SEED_ENTRIES, { source: 'liveboard:seed' });
	console.log(`[liveboard] seeded ${SEED_ENTRIES.length} entries (schema + starter cards)`);
}
