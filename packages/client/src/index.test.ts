/**
 * Browser client tests
 */

import { describe, it, expect } from 'vitest';
import { createClient, version } from './index';

describe('@fatos/client', () => {
	it('should export version', () => {
		expect(version).toBeDefined();
	});

	it('provides browser-friendly core APIs', () => {
		const client = createClient();

		client.transact([
			['add', 1, 'type', 'user'],
			['add', 1, 'name', 'Alice'],
			['add', 2, 'type', 'user']
		]);

		expect(client.find({ type: 'user' })).toEqual([
			{ id: 1, type: 'user', name: 'Alice' },
			{ id: 2, type: 'user' }
		]);
		expect(
			client.query({
				find: ['?e'],
				where: [['?e', 'type', 'user']]
			})
		).toEqual([[1], [2]]);
	});

	it('supports ergonomic tuple add and tuple transact', () => {
		const client = createClient();

		client.add(['eid1', 'name', 'Alice']);
		client.add(['eid1', 'name', 'Alicia']);
		client.transact([
			['eid1', 'type', 'user'],
			['eid2', 'name', 'Bob']
		]);

		expect(client.entity('eid1')).toEqual({ id: 'eid1', name: 'Alicia', type: 'user' });
		expect(client.entity('eid2')).toEqual({ id: 'eid2', name: 'Bob' });
	});

	it('observes query criteria changes reactively', () => {
		const client = createClient();
		const snapshots: Array<Array<{ id: number; type: string }>> = [];

		const unsubscribe = client.observe({ type: 'user' }, (entities) => {
			snapshots.push(entities as Array<{ id: number; type: string }>);
		});

		client.add(1, 'type', 'user');
		client.add(2, 'type', 'admin');
		client.add(3, 'type', 'user');
		unsubscribe();
		client.add(4, 'type', 'user');

		expect(snapshots).toEqual([
			[],
			[{ id: 1, type: 'user' }],
			[
				{ id: 1, type: 'user' },
				{ id: 3, type: 'user' }
			]
		]);
	});

	it('supports transaction-scoped reads through atTransaction', () => {
		const client = createClient();
		client.add(7, 'name', 'Alice');
		client.add(7, 'type', 'user');
		client.retract(7, 'type', 'user');

		const at2 = client.atTransaction(2);
		const at3 = client.atTransaction(3);

		expect(at2.entity(7)).toEqual({ id: 7, name: 'Alice', type: 'user' });
		expect(at3.entity(7)).toEqual({ id: 7, name: 'Alice' });
	});
});
