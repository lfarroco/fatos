/**
 * Unit tests: interned attribute keys and canonical string instances (design/05).
 *
 * The EAVT/AEVT/AVET indexes are keyed by internal numeric attribute ids, and equal
 * string content for entity ids and attributes is stored once (canonical instance).
 * These tests pin the observable guarantees: behavior is byte-for-byte identical to the
 * pre-interning engine, equal content from distinct string instances behaves the same,
 * and no internal id ever leaks through the public API.
 */

import { describe, expect, it, vi } from 'vitest';
import { createDatabase } from './index';

describe('canonical string instances (design/05)', () => {
	it('stores one canonical attribute instance per distinct ident', () => {
		const db = createDatabase();
		// `['user', 'name'].join('/')` is a runtime-built instance — guaranteed distinct
		// from the `'user/name'` literal below.
		const fresh = ['user', 'name'].join('/');
		db.add(1, 'user/name', 'Alice');
		db.add(1, fresh, 'Alicia');

		const facts = db.getFacts();
		expect(facts).toHaveLength(2);
		// Equal content shares a single string object across the fact log.
		expect(facts[0]?.[1]).toBe(facts[1]?.[1]);
		expect(facts[0]?.[1]).toBe('user/name');
	});

	it('stores one canonical eid instance per distinct string entity id', () => {
		const db = createDatabase();
		const fresh = ['user', '2'].join(':');
		db.add('user:2', 'name', 'Bob');
		db.add(fresh, 'age', 30);

		const facts = db.getFacts();
		expect(facts[0]?.[0]).toBe(facts[1]?.[0]);
		expect(facts[0]?.[0]).toBe('user:2');
	});

	it('treats equal-content eids from distinct instances as the same entity', () => {
		const db = createDatabase();
		db.add(['u', '1'].join(':'), 'name', 'Alice');
		db.add('u:1', 'age', 22);

		expect(db.entity('u:1')).toEqual({ id: 'u:1', name: 'Alice', age: 22 });
		expect(db.entity(['u', '1'].join(':'))).toEqual({ id: 'u:1', name: 'Alice', age: 22 });
		expect(db.getFacts()).toHaveLength(2);
	});

	it('keeps first-fact attribute ordering even when interner order differs', () => {
		const db = createDatabase();
		// A live selector interns 'a' before any write, giving it a lower attrId than
		// 'z' — the index must still present attributes in first-write order (z, a),
		// never id order (a, z).
		const live = db.live(() => db.find({ a: 1 }).length);
		db.add('u1', 'z', 1);
		db.add('u1', 'a', 2);
		const entity = db.entity('u1');
		expect(entity).toEqual({ id: 'u1', z: 1, a: 2 });
		expect(Object.keys(entity ?? {})).toEqual(['id', 'z', 'a']);
		live.dispose();
	});
});

describe('indexed reads with interned keys', () => {
	it('returns empty results for never-written attributes (reads do not fabricate data)', () => {
		const db = createDatabase();
		db.add(1, 'a', 'x');

		expect(db.getFactsByAttribute('nope')).toEqual([]);
		expect(db.getFactsByEntityAttribute(1, 'nope')).toEqual([]);
		expect(db.getFactsByAttributeValue('nope', 'x')).toEqual([]);
		expect(db.find({ nope: 'x' })).toEqual([]);

		// The first write of that attribute behaves identically to a fresh attribute.
		db.add(1, 'nope', 'y');
		expect(db.getFactsByAttribute('nope')).toEqual([[1, 'nope', 'y', 2, 'add']]);
		expect(db.entity(1)).toEqual({ id: 1, a: 'x', nope: 'y' });
	});

	it('round-trips find and datalog queries on string entity ids', () => {
		const db = createDatabase();
		db.add('user:1', 'role', 'admin');
		db.add('user:2', 'role', 'viewer');

		expect(db.find({ role: 'admin' })).toEqual([{ id: 'user:1', role: 'admin' }]);
		expect(db.query({ find: ['?e'], where: [['?e', 'role', 'viewer']] })).toEqual([['user:2']]);
		expect(db.getFactsByAttributeValue('role', 'admin')).toEqual([['user:1', 'role', 'admin', 1, 'add']]);
	});

	it('cardinality-many dedup works with fresh attribute instances', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/tags', valueType: 'string', cardinality: 'many' }]);
		db.transact([
			['add', 'u:1', ['user', 'tags'].join('/'), 'ts'],
			['add', 'u:1', 'user/tags', 'db'],
			['add', 'u:1', 'user/tags', 'ts']
		]);

		expect(db.entity('u:1')).toEqual({ id: 'u:1', 'user/tags': ['ts', 'db'] });
		expect(db.query({ find: ['?t'], where: [['?e', 'user/tags', '?t']] })).toEqual([['ts'], ['db']]);
	});

	it('enforces unique constraints across interned indexes', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/email', valueType: 'string', cardinality: 'one', unique: 'value' }]);
		db.add(1, 'user/email', 'a@example.com');
		expect(() => db.add(2, 'user/email', 'a@example.com')).toThrow(/Unique constraint violation/);
		expect(db.find({ 'user/email': 'a@example.com' })).toEqual([
			{ id: 1, 'user/email': 'a@example.com' }
		]);
	});

	it('resolves identity-unique upserts on string attributes', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/slug', valueType: 'string', cardinality: 'one', unique: 'identity' }]);
		const first = db.insert({ 'user/slug': 'alice', 'user/name': 'Alice' });
		const second = db.insert({ 'user/slug': 'alice', 'user/name': 'Alicia' });
		expect(second).toBe(first);
		expect(db.entity(first)).toEqual({ id: first, 'user/slug': 'alice', 'user/name': 'Alicia' });
	});
});

describe('restore determinism with interned indexes', () => {
	it('rebuilds a restored database observably identical to the original', () => {
		const db = createDatabase();
		db.add(['user', '1'].join(':'), ['user', 'name'].join('/'), 'Alice');
		db.transact([
			{ ident: 'user/name', valueType: 'string', cardinality: 'one' },
			{ ident: 'user/email', valueType: 'string', cardinality: 'one', unique: 'value' }
		]);
		// Pre-existing facts on a unique attribute: the restored database must rebuild
		// the unique index lazily (uniqueIndex.clear() in restore) and enforce it.
		db.add(1, 'user/email', 'a@example.com');

		const snapshot = { facts: db.getFacts(), transactions: db.getTransactions() };
		const restored = createDatabase();
		restored.restore(snapshot);

		expect(restored.getFacts()).toEqual(db.getFacts());
		expect(restored.getTransactions()).toEqual(db.getTransactions());
		expect(restored.entity('user:1')).toEqual(db.entity('user:1'));
		expect(restored.find({ 'user/name': 'Alice' })).toEqual(db.find({ 'user/name': 'Alice' }));
		expect(restored.getSchemas()).toEqual(db.getSchemas());

		// Unique enforcement works identically after restore (lazy rebuild on write).
		expect(() => restored.add(2, 'user/email', 'a@example.com')).toThrow(/Unique constraint violation/);
		expect(() => db.add(2, 'user/email', 'a@example.com')).toThrow(/Unique constraint violation/);
		// Same-entity re-add of the same value is allowed on both.
		restored.add(1, 'user/email', 'a@example.com');
		db.add(1, 'user/email', 'a@example.com');
		expect(restored.getFacts()).toEqual(db.getFacts());

		// Subsequent writes keep the two databases in lock-step.
		restored.add('user:1', 'user/note', 'first');
		db.add('user:1', 'user/note', 'first');
		expect(restored.getFacts()).toEqual(db.getFacts());
		expect(restored.entity('user:1')).toEqual(db.entity('user:1'));
	});
});

describe('live queries with interned keys and string eids', () => {
	it('tracks and notifies for string entity ids', () => {
		const db = createDatabase();
		db.add('user:1', 'role', 'admin');

		const live = db.live((state) => state.entity('user:1')?.['role']);
		expect(live.current).toBe('admin');

		const seen: unknown[] = [];
		live.subscribe((value) => seen.push(value));

		db.add('user:1', 'role', 'viewer');
		expect(live.current).toBe('viewer');
		expect(seen).toEqual(['viewer']);
		live.dispose();
	});

	it('does not re-run on unrelated attributes for string entities', () => {
		const db = createDatabase();
		db.add('u:1', 'role', 'admin');

		const fn = vi.fn(() => db.find({ role: 'admin' }).map((user) => user.id));
		const live = db.live(fn);
		expect(live.current).toEqual(['u:1']);
		expect(fn).toHaveBeenCalledTimes(1);

		db.add('u:1', 'name', 'Alice');
		expect(fn).toHaveBeenCalledTimes(1);

		db.add('u:2', 'role', 'admin');
		expect(fn).toHaveBeenCalledTimes(2);
		expect(live.current).toEqual(['u:1', 'u:2']);
		live.dispose();
	});

	it('tracks reads through entity proxies for string entities', () => {
		const db = createDatabase();
		db.add('u:1', 'user/name', 'Alice');

		const fn = vi.fn(() => {
			const entity = db.entity('u:1');
			return entity === null ? null : entity['user/name'];
		});
		const live = db.live(fn);
		expect(live.current).toBe('Alice');

		db.add('u:1', 'user/age', 30);
		expect(fn).toHaveBeenCalledTimes(1);

		db.add('u:1', 'user/name', 'Alicia');
		expect(fn).toHaveBeenCalledTimes(2);
		expect(live.current).toBe('Alicia');
		live.dispose();
	});

	it('notifies on the very first write of a tracked attribute (new-pair path)', () => {
		const db = createDatabase();
		const fn = vi.fn(() => db.find({ status: 'ready' }).map((user) => user.id));
		const live = db.live(fn);
		expect(live.current).toEqual([]);
		expect(fn).toHaveBeenCalledTimes(1);

		db.add('n:1', 'status', 'ready');
		expect(fn).toHaveBeenCalledTimes(2);
		expect(live.current).toEqual(['n:1']);
		live.dispose();
	});
});
