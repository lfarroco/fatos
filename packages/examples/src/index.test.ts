/**
 * Examples tests — every example program doubles as a live behavior check.
 */
import { describe, expect, it } from 'vitest';
import { run as basicUsage } from './basic-usage';
import { run as schema } from './schema';
import { run as datalogQuery } from './datalog-query';
import { run as timeTravel } from './time-travel';
import { run as reactive } from './reactive';
import { run as serverExample } from './server-example';
import { run as reactExample } from './react-example';
import { run as schemaDesigner } from './schema-designer';
import { run as fullStackApp } from './full-stack-app';
import { runAll, version } from './index';

describe('@fatos/examples', () => {
	it('should export version', () => {
		expect(version).toBeDefined();
	});

	it('basic-usage: stores facts, commits transactions, and reads entities', () => {
		const result = basicUsage();

		expect(result.facts[0]).toEqual([1, 'user/name', 'Alice', 1, 'add']);
		expect(result.facts.length).toBeGreaterThan(0);
		expect(result.transactions.length).toBeGreaterThan(1);
		expect(result.transactions.find((tx) => tx[2] !== null)?.[2]).toEqual({ source: 'seed' });
		expect(result.alice).toMatchObject({
			id: 1,
			'user/name': 'Alice',
			'user/role': 'admin',
			'user/active': true
		});
		expect(result.admins.map((user) => user?.id)).toEqual([1]);
		expect(result.stringEntity).toMatchObject({ id: 'user:2', 'user/name': 'Bob' });
		expect(result.byAttribute).toHaveLength(3);
		expect(result.byValue).toHaveLength(2);
		expect(result.byEntityAttribute).toEqual([[1, 'user/name', 'Alice', 1, 'add']]);
	});

	it('schema: declares attributes and enforces value types and cardinality', () => {
		const result = schema();

		expect(result.schemas.map((s) => s.ident)).toEqual(['user/age', 'user/name', 'user/tags']);
		expect(result.alice).toMatchObject({ id: 1, 'user/name': 'Alicia', 'user/age': 22 });
		expect(result.tagged).toMatchObject({ 'user/tags': ['typescript', 'datomic', 'eav'] });
		expect(result.valueTypeError).toMatch(/Invalid value type/);
		expect(result.cardinalityError).toMatch(/Cardinality conflict/);
		expect(result.redeclaredError).toMatch(/Schema conflict/);
	});

	it('query: joins, projects, deduplicates, and reads past snapshots', () => {
		const result = datalogQuery();

		expect(result.allUsers).toEqual([[1], [2], [4]]);
		expect(result.names).toEqual([['Alice'], ['Bob']]);
		expect(result.withConstant).toEqual([
			[1, 'user'],
			[2, 'user'],
			[4, 'user']
		]);
		expect(result.deduplicated).toEqual([['Alice'], ['Bob']]);
		expect(result.tagged).toEqual([[1], [2]]);
		expect(result.currentUsers).toEqual([[1], [4]]);
		expect(result.usersBeforeRetraction).toEqual([[1], [2], [4]]);
	});

	it('time-travel: reconstructs state as of any past transaction', () => {
		const result = timeTravel();

		expect(result.atCreated).toMatchObject({ 'order/status': 'placed' });
		expect(result.atShipped).toMatchObject({ 'order/status': 'shipped' });
		expect(result.atDelivered).toMatchObject({ 'order/status': 'delivered' });
		expect(result.now).toMatchObject({ 'order/status': 'delivered' });
		expect(result.history).toHaveLength(6);
		expect(result.auditLog.map((tx) => tx[2])).toEqual([
			{ source: 'seed' },
			{ source: 'customer' },
			{ source: 'warehouse' },
			{ source: 'warehouse' },
			{ source: 'courier' },
			{ source: 'courier' }
		]);
	});

	it('reactive: observers push only when their results change', () => {
		const result = reactive();

		expect(result.events).toEqual([
			'admins=0',
			'entity1=none',
			'active=0',
			'transactions=0',
			'admins=1',
			'entity1=Alice',
			'active=1',
			'transactions=1',
			'transactions=2',
			'transactions=3'
		]);
		expect(result.afterUnsubscribe).toBe(result.events.length);
	});

	it('server: exposes the REST API and broadcasts over WebSocket', async () => {
		const result = await serverExample();

		expect(result.health).toEqual({ status: 'ok' });
		expect(result.entity).toMatchObject({ id: 1, 'item/name': 'coffee', 'item/stock': 12 });
		expect(result.facts.length).toBeGreaterThanOrEqual(6);
		expect(result.transactions.length).toBeGreaterThanOrEqual(2);
		expect(result.websocketEventTypes).toContain('fact:added');
		expect(result.websocketEventTypes).toContain('transaction:committed');
		expect(result.subscribedEvents.some((event) => event.type === 'transaction:committed')).toBe(true);
	});

	it('react: renders the todo app from hooks against a seeded client', () => {
		const { html } = reactExample();

		expect(html).toContain('Buy milk');
		expect(html).toContain('Learn fatos');
		expect(html).toContain('1 completed');
		expect(html).toContain('tx 1');
		expect(html).toContain('tx 2');
	});

	it('schema-designer: converts designer documents to facts and back', () => {
		const result = schemaDesigner();

		expect(result.restored.schema.entities).toHaveLength(2);
		expect(result.entriesCount).toBeGreaterThan(0);
		expect(result.userEntity).toMatchObject({ id: 1, 'User/name': 'Alice', 'User/age': 30 });
		expect(result.postEntity).toMatchObject({ id: 2, 'Post/title': 'Hello fatos' });
		expect(result.importedEntities).toBe(2);
		expect(result.validationError).toMatch(/Document version must be 1/);
	});

	it('full-stack: two clients share one server with real-time sync', async () => {
		const result = await fullStackApp();

		expect(result.inventoryBeforeSale).toMatchObject({ 'item/stock': 12 });
		expect(result.inventoryNow).toMatchObject({ 'item/stock': 11 });
		expect(result.milk).toMatchObject({ id: 3, 'item/name': 'milk', 'item/stock': 24 });
		expect(result.transactionCount).toBe(4);
		expect(result.warehouseEventTypes).toContain('fact:retracted');
		expect(result.warehouseEventTypes).toContain('fact:added');
		expect(result.warehouseEventTypes).toContain('transaction:committed');
		expect(result.storefrontEvents.filter((event) => event.type === 'transaction:committed')).toHaveLength(4);
	});

	it('runAll: every example runs end to end', async () => {
		await expect(runAll()).resolves.toBeUndefined();
	});
});


