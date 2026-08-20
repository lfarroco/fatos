/**
 * Unit tests: merge / mergeEntity — the eid-keyed reconcile API (design/02).
 * Also covers the side-effect-free plan helpers (`planInsert`, `planSet`,
 * `planMerge`) that power the client/server write-through sugar.
 */

import { describe, it, expect } from 'vitest';
import { createDatabase, type EntityId } from './index';

describe('merge — eid-keyed reconcile', () => {
	it('creates new entities from an eid-keyed map and returns aligned ids', () => {
		const db = createDatabase();
		const ids = db.merge({
			eid1: { name: 'weee', age: 33 },
			eid2: { name: 'Bob' }
		});
		expect(ids).toEqual(['eid1', 'eid2']);
		expect(db.entity('eid1')).toEqual({ id: 'eid1', name: 'weee', age: 33 });
		expect(db.entity('eid2')).toEqual({ id: 'eid2', name: 'Bob' });
	});

	it('commits the whole merge as one transaction', () => {
		const db = createDatabase();
		db.merge({
			eid1: { a: 1 },
			eid2: { b: 2 }
		});
		expect(db.getTransactions()).toHaveLength(1);
	});

	it('reconciles an existing entity instead of throwing a cardinality conflict', () => {
		const db = createDatabase();
		db.merge({ eid1: { name: 'weee', age: 33 } });
		db.merge({ eid1: { name: 'wow', age: 33 } });
		expect(db.entity('eid1')).toEqual({ id: 'eid1', name: 'wow', age: 33 });
		// the changed attribute was retracted then re-added; the unchanged one was left alone
		expect(db.getFactsByEntity('eid1')).toEqual([
			['eid1', 'name', 'weee', 1, 'add'],
			['eid1', 'age', 33, 1, 'add'],
			['eid1', 'name', 'weee', 2, 'retract'],
			['eid1', 'name', 'wow', 2, 'add']
		]);
	});

	it('is distinct from insert: insert throws on a changed one-valued attribute', () => {
		const db = createDatabase();
		db.merge({ eid1: { name: 'weee' } });
		expect(() => db.insert({ id: 'eid1', name: 'wow' })).toThrow(/Cardinality conflict/);
		// merge reconciles instead
		expect(db.merge({ eid1: { name: 'wow' } })).toEqual(['eid1']);
	});

	it('is a no-op (no transaction) when nothing changes', () => {
		const db = createDatabase();
		db.merge({ eid1: { name: 'weee' } });
		const txsBefore = db.getTransactions().length;
		db.merge({ eid1: { name: 'weee' } });
		expect(db.getTransactions()).toHaveLength(txsBefore);
	});

	it('removes an attribute with null', () => {
		const db = createDatabase();
		db.merge({ eid1: { name: 'weee', age: 33 } });
		db.merge({ eid1: { name: null } });
		expect(db.entity('eid1')).toEqual({ id: 'eid1', age: 33 });
	});

	it('expands fresh arrays into cardinality-many facts and reconciles the member set', () => {
		const db = createDatabase();
		db.merge({ eid1: { tags: ['a', 'b'] } });
		expect(db.getSchema('tags')).toMatchObject({ ident: 'tags', cardinality: 'many' });

		const tagsBefore = db.entity('eid1')?.['tags'] as unknown[];
		expect([...tagsBefore].sort()).toEqual(['a', 'b']);

		db.merge({ eid1: { tags: ['a', 'c'] } });
		const tagsAfter = db.entity('eid1')?.['tags'] as unknown[];
		expect([...tagsAfter].sort()).toEqual(['a', 'c']);

		// 'b' retracted, 'c' added — the unchanged member 'a' was left alone
		expect(db.getFactsByEntityAttribute('eid1', 'tags')).toEqual([
			['eid1', 'tags', 'a', 1, 'add'],
			['eid1', 'tags', 'b', 1, 'add'],
			['eid1', 'tags', 'b', 2, 'retract'],
			['eid1', 'tags', 'c', 2, 'add']
		]);
	});

	it('reconciles against explicitly declared cardinality-many schema', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/tags', valueType: 'string', cardinality: 'many' }]);
		db.merge({ user: { tags: ['a', 'b'] } });
		db.merge({ user: { tags: ['a'] } });
		expect(db.getFactsByEntityAttribute('user', 'tags')).toEqual([
			['user', 'tags', 'a', 2, 'add'],
			['user', 'tags', 'b', 2, 'add'],
			['user', 'tags', 'b', 3, 'retract']
		]);
	});
});

describe('plan helpers (side-effect-free)', () => {
	it('planInsert returns the entries insert would commit without writing', () => {
		const db = createDatabase();
		const plan = db.planInsert({ id: 'eid1', name: 'weee' });
		expect(plan.results).toEqual(['eid1']);
		expect(db.getFacts()).toHaveLength(0);
		expect(db.getTransactions()).toHaveLength(0);

		db.transact(plan.entries);
		expect(db.entity('eid1')).toEqual({ id: 'eid1', name: 'weee' });
	});

	it('planSet returns the diff set would commit without writing', () => {
		const db = createDatabase();
		db.merge({ eid1: { name: 'weee', age: 33 } });
		const diff = db.planSet('eid1', { name: 'wow' });
		expect(diff).toEqual([
			['retract', 'eid1', 'name', 'weee'],
			['add', 'eid1', 'name', 'wow']
		]);
		expect(db.entity('eid1')).toEqual({ id: 'eid1', name: 'weee', age: 33 });

		db.set('eid1', { name: 'wow' });
		expect(db.entity('eid1')).toEqual({ id: 'eid1', name: 'wow', age: 33 });
	});

	it('planMerge returns the entries merge would commit without writing', () => {
		const db = createDatabase();
		db.merge({ eid1: { name: 'weee' } });
		const plan = db.planMerge({ eid1: { name: 'wow', age: 33 } });
		expect(plan.results).toEqual(['eid1']);
		expect(db.entity('eid1')).toEqual({ id: 'eid1', name: 'weee' });

		db.merge({ eid1: { name: 'wow', age: 33 } });
		expect(db.entity('eid1')).toEqual({ id: 'eid1', name: 'wow', age: 33 });
	});

	it('planMergeEntity plans the single-entity form', () => {
		const db = createDatabase();
		db.mergeEntity(7, { name: 'seven' });
		const plan = db.planMergeEntity(7, { name: 'seven', age: 33 });
		expect(plan.results).toEqual([7]);
		expect(db.entity(7)).toEqual({ id: 7, name: 'seven' });
	});
});

