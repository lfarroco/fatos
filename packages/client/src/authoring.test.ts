/**
 * Client authoring-surface tests: the client is the complete object-map API
 * (insert/upsert/set/patch/merge/mergeEntity) plus pull/diff/at/restore, and
 * every write fires the same events as transact (design/03).
 */

import { describe, it, expect } from 'vitest';
import type { DatabaseSnapshot, Fact } from '@fatos/core';
import { createClient, FACT_ADDED_EVENT, FactEvent, TRANSACTION_COMMITTED_EVENT } from './index';

describe('FatosClient object-map authoring', () => {
	it('insert creates entities and returns aligned ids', () => {
		const client = createClient();
		expect(client.insert({ id: 'eid1', name: 'weee' })).toBe('eid1');
		const ids = client.insert([{ name: 'Alice' }, { name: 'Bob' }]);
		expect(ids).toEqual([expect.any(Number), expect.any(Number)]);
		expect(client.entity('eid1')).toEqual({ id: 'eid1', name: 'weee' });
		expect(client.find({ name: 'Alice' })).toHaveLength(1);
	});

	it('upsert resolves identity-unique attributes to the same entity', () => {
		const client = createClient();
		client.transact([
			{ ident: 'user/email', valueType: 'string', cardinality: 'one', unique: 'identity' }
		]);
		const a = client.upsert({ 'user/email': 'a@b.c', name: 'Alice' });
		const b = client.upsert({ 'user/email': 'a@b.c', role: 'admin' });
		expect(a).toBe(b);
		expect(client.entity(a)).toEqual({ id: a, 'user/email': 'a@b.c', name: 'Alice', role: 'admin' });
	});

	it('set computes the retract+add diff and fires transaction events', () => {
		const client = createClient();
		client.add('eid1', 'name', 'weee');

		const events: string[] = [];
		client.addEventListener(TRANSACTION_COMMITTED_EVENT, () => events.push('tx'));
		const facts = client.set('eid1', { name: 'wow', age: 33 });

		expect(facts).toEqual([
			['eid1', 'name', 'weee', 2, 'retract'],
			['eid1', 'name', 'wow', 2, 'add'],
			['eid1', 'age', 33, 2, 'add']
		]);
		expect(events).toEqual(['tx']);
		expect(client.entity('eid1')).toEqual({ id: 'eid1', name: 'wow', age: 33 });
	});

	it('patch is an alias of set (null removes the attribute)', () => {
		const client = createClient();
		client.merge({ eid1: { name: 'weee' } });
		client.patch('eid1', { name: null });
		// the only attribute was retracted, so the entity no longer exists
		expect(client.entity('eid1')).toBeNull();
		expect(client.getFactsByEntity('eid1')).toEqual([
			['eid1', 'name', 'weee', 1, 'add'],
			['eid1', 'name', 'weee', 2, 'retract']
		]);
	});

	it('merge reconciles an existing entity and returns aligned ids', () => {
		const client = createClient();
		client.merge({ eid1: { name: 'weee', age: 33 } });
		expect(client.merge({ eid1: { name: 'wow' } })).toEqual(['eid1']);
		expect(client.entity('eid1')).toEqual({ id: 'eid1', name: 'wow', age: 33 });
	});

	it('mergeEntity accepts numeric ids', () => {
		const client = createClient();
		expect(client.mergeEntity(1, { name: 'weee' })).toBe(1);
		expect(client.entity(1)).toEqual({ id: 1, name: 'weee' });
	});

	it('emits fact events for object-map writes', () => {
		const client = createClient();
		const added: string[] = [];
		client.addEventListener(FACT_ADDED_EVENT, (event) => {
			added.push(`${String((event as FactEvent).fact[0])}:${(event as FactEvent).fact[1]}`);
		});

		client.insert({ id: 'eid1', name: 'weee' });
		client.merge({ eid1: { age: 33 } });
		// Schema auto-declarations fire too (negative internal eids); the entity facts:
		expect(added.filter((entry) => !entry.startsWith('-'))).toEqual(['eid1:name', 'eid1:age']);
	});

	it('exposes the underlying core database through .db', () => {
		const client = createClient();
		expect(client.db).toBeDefined();
		client.db.add(1, 'name', 'direct');
		expect(client.entity(1)).toEqual({ id: 1, name: 'direct' });
	});
});

describe('FatosClient core read parity (pull/diff/at/restore)', () => {
	it('pull resolves dot-paths into nested objects', () => {
		const client = createClient();
		client.merge({
			user: { name: 'Alice', manager: { name: 'Bob' } }
		});
		expect(client.pull('user', 'name manager.name')).toEqual({
			id: 'user',
			name: 'Alice',
			manager: { id: expect.any(Number), name: 'Bob' }
		});
	});

	it('diff reports the facts between two transactions', () => {
		const client = createClient();
		client.merge({ eid1: { name: 'weee' } });
		const before = client.getTransactions().at(-1)?.[0] ?? 0;
		client.set('eid1', { age: 33 });
		const after = client.getTransactions().at(-1)?.[0] ?? 0;
		const diff = client.diff(before, after);
		expect(diff.added).toEqual([['eid1', 'age', 33, after, 'add']]);
		expect(diff.retracted).toEqual([]);
	});

	it('at(tx) is the time-travel read view alias', () => {
		const client = createClient();
		client.merge({ eid1: { name: 'weee' } });
		client.set('eid1', { name: 'wow' });
		const tx = client.getTransactions().at(-1)?.[0] ?? 0;
		const view = client.at(tx);
		expect(view.entity('eid1')).toEqual({ id: 'eid1', name: 'wow' });
		expect(view.find({ name: 'wow' })).toEqual([{ id: 'eid1', name: 'wow' }]);
		expect(view.query({ find: ['?e'], where: [['?e', 'name', 'wow']] })).toEqual([['eid1']]);
		expect(view.pull('eid1', ['name'])).toEqual({ id: 'eid1', name: 'wow' });
	});

	it('restore rebuilds state from a snapshot', () => {
		const source = createClient();
		source.merge({ eid1: { name: 'weee', age: 33 } });
		const snapshot: DatabaseSnapshot = { facts: source.getFacts(), transactions: source.getTransactions() };

		const restored = createClient();
		restored.restore(snapshot);
		expect(restored.entity('eid1')).toEqual({ id: 'eid1', name: 'weee', age: 33 });
		expect(restored.getTransactions()).toEqual(source.getTransactions());
		expect(restored.getFacts()).toEqual(source.getFacts());
	});
});
