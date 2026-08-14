/**
 * P1 transact & query surface tests (design/02): insert object maps + nested
 * graph flattening, upsert by db/unique: 'identity', set/patch diff updates,
 * find operators + ordering/paging/select, pull dot-paths, at/diff time
 * travel, and datalog operator clauses with Date/BigInt/ref constants.
 */

import { describe, it, expect } from 'vitest';
import {
	createDatabase,
	isRef,
	lookupRef,
	ref,
	temp,
	REF_BRAND,
	type DiffResult,
	type EntityId
} from './index';

describe('insert — object maps', () => {
	it('allocates ids when id is omitted and returns ids aligned to input', () => {
		const db = createDatabase();
		const [alice, bob] = db.insert([
			{ 'user/name': 'Alice', 'user/age': 22 },
			{ 'user/name': 'Bob' }
		]);

		expect(typeof alice).toBe('number');
		expect(typeof bob).toBe('number');
		expect(alice).not.toBe(bob);
		expect(db.entity(alice)).toEqual({ id: alice, 'user/name': 'Alice', 'user/age': 22 });
		expect(db.entity(bob)).toEqual({ id: bob, 'user/name': 'Bob' });

		// single-map form returns one id
		const solo = db.insert({ 'user/name': 'Solo' });
		expect(typeof solo).toBe('number');
	});

	it('accepts stable string ids and aliases repeated negative tempids within one call', () => {
		const db = createDatabase();
		const [a, b, c] = db.insert([
			{ id: -1, 'user/name': 'First' },
			{ id: -1, 'user/name': 'Second' },
			{ id: 'stable', 'user/name': 'Stable' }
		]);

		expect(a).toBe(b);
		expect(c).toBe('stable');
		expect(db.entity(a)).toEqual({ id: a, 'user/name': 'Second' });
		expect(db.entity('stable')).toEqual({ id: 'stable', 'user/name': 'Stable' });
	});

	it('aliases temp() handles used as ids and refs across maps', () => {
		const db = createDatabase();
		const parent = temp('parent');
		const [pid] = db.insert([
			{
				id: parent,
				'user/name': 'Parent',
				'user/kid': { 'user/name': 'Kid', 'user/parent': ref(parent) }
			}
		]);

		const kid = (db.entity(pid) as { 'user/kid': unknown })['user/kid'] as { [REF_BRAND]: EntityId };
		expect(isRef(kid)).toBe(true);
		expect(db.entity(kid[REF_BRAND])).toMatchObject({ 'user/name': 'Kid' });
		expect(db.entity(kid[REF_BRAND])).toMatchObject({ 'user/parent': ref(pid) });
	});

	it('expands arrays into cardinality-many facts (P1 array expansion)', () => {
		const db = createDatabase();
		const [id] = db.insert([{ 'user/tags': ['ts', 'db', 'ts'] }]);

		expect(db.getSchema('user/tags')).toMatchObject({ cardinality: 'many' });
		expect(db.entity(id)).toEqual({ id, 'user/tags': ['ts', 'db'] });
		expect(db.getFactsByEntityAttribute(id, 'user/tags')).toHaveLength(3);
	});

	it('rejects arrays on cardinality-one attributes', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/name', valueType: 'string', cardinality: 'one' }]);
		expect(() => db.insert({ 'user/name': ['a', 'b'] })).toThrow(/Cardinality conflict/);
	});

	it('flattens nested object graphs deterministically (depth-first, parent-major)', () => {
		const db = createDatabase();
		const first = db.insert({
			'user/name': 'Alice',
			'user/address': { 'address/city': 'Berlin', 'address/zip': '10115' }
		});
		const second = db.insert({
			'user/name': 'Alice',
			'user/address': { 'address/city': 'Berlin', 'address/zip': '10115' }
		});

		// identical inputs produce identical attribute shapes and nested fact logs
		const topAttrs = (top: EntityId): Array<[string, unknown]> =>
			db.getFacts().filter((fact) => fact[0] === top).map((fact) => [fact[1], fact[2]] as const);
		expect(topAttrs(first).map(([attribute]) => attribute)).toEqual(
			topAttrs(second).map(([attribute]) => attribute)
		);
		const nestedA = topAttrs(first).find(([a]) => a === 'user/address')?.[1] as { [REF_BRAND]: EntityId };
		const nestedB = topAttrs(second).find(([a]) => a === 'user/address')?.[1] as { [REF_BRAND]: EntityId };
		const nestedFacts = (nestedId: EntityId): Array<[string, unknown, string]> =>
			db.getFactsByEntity(nestedId).map((fact) => [fact[1], fact[2], fact[4]] as const);
		expect(nestedFacts(nestedA[REF_BRAND])).toEqual(nestedFacts(nestedB[REF_BRAND]));

		const pulled = db.pull(first, 'user.name user.address.address.city user.address.address.zip');
		expect(pulled).toMatchObject({
			id: first,
			'user/name': 'Alice',
			'user/address': { 'address/city': 'Berlin', 'address/zip': '10115' }
		});
		expect(db.getSchema('user/address')).toMatchObject({ valueType: 'ref', cardinality: 'one' });
	});

	it('turns arrays of objects into many-valued ref attributes', () => {
		const db = createDatabase();
		const [id] = db.insert([
			{
				'user/name': 'Alice',
				'user/contact': [
					{ 'contact/type': 'email', 'contact/value': 'a@b.c' },
					{ 'contact/type': 'phone', 'contact/value': '+49 30 000' }
				]
			}
		]);

		expect(db.getSchema('user/contact')).toMatchObject({ valueType: 'ref', cardinality: 'many' });
		const contacts = (db.entity(id) as { 'user/contact': unknown[] })['user/contact'];
		expect(contacts).toHaveLength(2);

		const pulled = db.pull(id, 'user.contact.contact.type user.contact.contact.value');
		expect(pulled?.['user/contact']).toEqual([
			{
				id: (contacts[0] as { [REF_BRAND]: EntityId })[REF_BRAND],
				'contact/type': 'email',
				'contact/value': 'a@b.c'
			},
			{
				id: (contacts[1] as { [REF_BRAND]: EntityId })[REF_BRAND],
				'contact/type': 'phone',
				'contact/value': '+49 30 000'
			}
		]);
	});

	it('rejects empty and $-tagged objects (opaque scalars-as-objects)', () => {
		const db = createDatabase();
		expect(() => db.insert({ 'user/x': {} })).toThrow(/empty objects/);
		expect(() => db.insert({ 'user/x': { $ref: 1 } })).toThrow(/not supported as values/);
		expect(() => db.insert({ 'user/x': { $gt: 1 } })).toThrow(/not supported as values/);
		expect(() => db.insert({ 'user/x': [{ 'a/b': 1 }, 2] })).toThrow(/cannot mix nested objects and scalar values/);
	});

	it('rejects bare temp() in value position', () => {
		const db = createDatabase();
		expect(() => db.insert({ 'user/x': temp('nope') })).toThrow(/temp\(\)/);
	});

	it('raises on db/unique: value duplicates', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/ssn', valueType: 'string', cardinality: 'one', unique: 'value' }]);
		db.insert({ 'user/ssn': '123' });
		expect(() => db.insert({ 'user/ssn': '123' })).toThrow(/Unique constraint violation/);
	});
});

describe('upsert — db/unique: identity', () => {
	function seeded(): ReturnType<typeof createDatabase> {
		const db = createDatabase();
		db.transact([{ ident: 'user/email', valueType: 'string', cardinality: 'one', unique: 'identity' }]);
		return db;
	}

	it('matches an existing entity by identity value and adds facts to it', () => {
		const db = seeded();
		const alice = db.insert({ 'user/email': 'a@b.c', 'user/name': 'Alice' });

		const matched = db.upsert({ 'user/email': 'a@b.c', 'user/name': 'Alicia' });
		expect(matched).toBe(alice);
		expect(db.entity(alice)).toEqual({ id: alice, 'user/email': 'a@b.c', 'user/name': 'Alicia' });
	});

	it('insert also upserts when an identity attribute is present (design/02)', () => {
		const db = seeded();
		const alice = db.insert({ 'user/email': 'a@b.c', 'user/name': 'Alice' });
		const again = db.insert({ 'user/email': 'a@b.c', 'user/name': 'Alicia' });
		expect(again).toBe(alice);
		expect(db.find({ 'user/email': 'a@b.c' })).toEqual([
			{ id: alice, 'user/email': 'a@b.c', 'user/name': 'Alicia' }
		]);
	});

	it('matches via lookupRef on the identity attribute (P1 lookupRef resolution)', () => {
		const db = seeded();
		const alice = db.insert({ 'user/email': 'a@b.c', 'user/name': 'Alice' });

		const matched = db.upsert({ 'user/email': lookupRef(['user/email', 'a@b.c']), 'user/name': 'Alicia' });
		expect(matched).toBe(alice);
		// the lookupRef is an upsert marker: the plain scalar is stored
		expect(db.entity(alice)).toEqual({ id: alice, 'user/email': 'a@b.c', 'user/name': 'Alicia' });
	});

	it('resolves lookupRef values in other attributes to ref() of the matched entity', () => {
		const db = seeded();
		const alice = db.insert({ 'user/email': 'a@b.c' });
		db.transact([{ ident: 'user/manager', valueType: 'ref', cardinality: 'one' }]);

		const bob = db.insert({ 'user/name': 'Bob', 'user/manager': lookupRef(['user/email', 'a@b.c']) });
		expect((db.entity(bob) as { 'user/manager': unknown })['user/manager']).toEqual(ref(alice));
	});

	it('raises when a lookupRef value matches nothing', () => {
		const db = seeded();
		expect(() => db.insert({ 'user/name': 'X', 'user/manager': lookupRef(['user/email', 'missing@x.y']) })).toThrow(
			/does not match any entity/
		);
	});

	it('creates a new entity when the identity value is unknown', () => {
		const db = seeded();
		const fresh = db.upsert({ 'user/email': 'new@x.y', 'user/name': 'New' });
		expect(db.entity(fresh)).toEqual({ id: fresh, 'user/email': 'new@x.y', 'user/name': 'New' });
	});
});
describe('set / patch — diff updates', () => {
	it('set(eid, attr, value) emits retract+add pairs in one transaction', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/name', valueType: 'string', cardinality: 'one' }]); // tx 1
		db.add(1, 'user/name', 'Alice'); // tx 2

		const facts = db.set(1, 'user/name', 'Alicia');
		expect(facts).toEqual([
			[1, 'user/name', 'Alice', 3, 'retract'],
			[1, 'user/name', 'Alicia', 3, 'add']
		]);
		expect(db.entity(1)).toEqual({ id: 1, 'user/name': 'Alicia' });
		expect(db.getTransactions()).toHaveLength(3); // one new transaction
	});

	it('set(eid, {map}) updates several attributes atomically', () => {
		const db = createDatabase();
		db.add(1, 'name', 'Alice');
		db.add(1, 'age', 22);

		const facts = db.set(1, { name: 'Alicia', age: 23 });
		expect(facts.map((fact) => [fact[1], fact[2], fact[4]] as const)).toEqual([
			['name', 'Alice', 'retract'],
			['name', 'Alicia', 'add'],
			['age', 22, 'retract'],
			['age', 23, 'add']
		]);
		expect(db.entity(1)).toEqual({ id: 1, name: 'Alicia', age: 23 });
	});

	it('is a no-op (no transaction) when nothing changes', () => {
		const db = createDatabase();
		db.add(1, 'name', 'Alice');
		const before = db.getTransactions().length;
		expect(db.set(1, 'name', 'Alice')).toEqual([]);
		expect(db.getTransactions()).toHaveLength(before);
	});

	it('patch with null retracts the attribute', () => {
		const db = createDatabase();
		db.add(1, 'name', 'Alice'); // tx 1
		db.add(1, 'age', 22); // tx 2

		const facts = db.patch(1, { name: null, age: 23 });
		expect(facts).toEqual([
			[1, 'name', 'Alice', 3, 'retract'],
			[1, 'age', 22, 3, 'retract'],
			[1, 'age', 23, 3, 'add']
		]);
		expect(db.entity(1)).toEqual({ id: 1, age: 23 });
	});

	it('set(eid, attr, null) also deletes', () => {
		const db = createDatabase();
		db.add(1, 'name', 'Alice');
		expect(db.set(1, 'name', null)).toEqual([[1, 'name', 'Alice', 2, 'retract']]);
		expect(db.entity(1)).toBeNull();
	});

	it('diffs cardinality-many attributes as sets', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/tags', valueType: 'string', cardinality: 'many' }]);
		db.transact([
			['add', 1, 'user/tags', 'a'],
			['add', 1, 'user/tags', 'b'],
			['add', 1, 'user/tags', 'c']
		]);

		const facts = db.set(1, 'user/tags', ['b', 'c', 'd']);
		expect(facts).toEqual([
			[1, 'user/tags', 'a', 3, 'retract'],
			[1, 'user/tags', 'd', 3, 'add']
		]);
		expect(db.entity(1)).toEqual({ id: 1, 'user/tags': ['b', 'c', 'd'] });
	});

	it('patch with null clears every member of a many-valued attribute', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/tags', valueType: 'string', cardinality: 'many' }]);
		db.transact([
			['add', 1, 'user/tags', 'a'],
			['add', 1, 'user/tags', 'b']
		]);
		const facts = db.patch(1, { 'user/tags': null });
		expect(facts.map((fact) => [fact[2], fact[4]] as const)).toEqual([
			['a', 'retract'],
			['b', 'retract']
		]);
		expect(db.entity(1)).toBeNull();
	});
});

describe('find — operators', () => {
	function seeded(): ReturnType<typeof createDatabase> {
		const db = createDatabase();
		db.transact([{ ident: 'user/tags', valueType: 'string', cardinality: 'many' }]);
		db.transact([
			['add', 1, 'user/name', 'Alice'],
			['add', 1, 'user/age', 30],
			['add', 1, 'user/tags', 'ts'],
			['add', 1, 'user/tags', 'db'],
			['add', 2, 'user/name', 'Bob'],
			['add', 2, 'user/age', 17],
			['add', 2, 'user/tags', 'web'],
			['add', 3, 'user/name', 'Carol'],
			['add', 3, 'user/age', 42],
			['add', 3, 'user/tags', 'ts']
		]);
		return db;
	}

	it('$eq and bare values match any member of cardinality-many attributes', () => {
		const db = seeded();
		expect(db.find({ 'user/tags': 'ts' })).toEqual([
			{ id: 1, 'user/name': 'Alice', 'user/age': 30, 'user/tags': ['ts', 'db'] },
			{ id: 3, 'user/name': 'Carol', 'user/age': 42, 'user/tags': ['ts'] }
		]);
		expect(db.find({ 'user/tags': { $eq: 'ts' } }).map((e) => e.id)).toEqual([1, 3]);
	});

	it('$ne matches any entity with a differing member (any-member semantics)', () => {
		const db = seeded();
		// Entity 1 has tags ['ts', 'db']: 'db' differs from 'ts', so it matches.
		expect(db.find({ 'user/tags': { $ne: 'ts' } }).map((e) => e.id)).toEqual([1, 2]);
	});

	it('$gt/$gte/$lt/$lte compare numbers, strings, and dates', () => {
		const db = seeded();
		expect(db.find({ 'user/age': { $gt: 18 } }).map((e) => e.id)).toEqual([1, 3]);
		expect(db.find({ 'user/age': { $gte: 30 } }).map((e) => e.id)).toEqual([1, 3]);
		expect(db.find({ 'user/age': { $lt: 18 } }).map((e) => e.id)).toEqual([2]);
		expect(db.find({ 'user/age': { $lte: 17 } }).map((e) => e.id)).toEqual([2]);
		expect(db.find({ 'user/age': { $gte: 18, $lt: 65 } }).map((e) => e.id)).toEqual([1, 3]);
	});

	it('$in / $nin test membership', () => {
		const db = seeded();
		expect(db.find({ 'user/age': { $in: [17, 42] } }).map((e) => e.id)).toEqual([2, 3]);
		expect(db.find({ 'user/age': { $nin: [17, 42] } }).map((e) => e.id)).toEqual([1]);
	});

	it('$contains matches a member of a many-valued attribute', () => {
		const db = seeded();
		expect(db.find({ 'user/tags': { $contains: 'ts' } }).map((e) => e.id)).toEqual([1, 3]);
		expect(db.find({ 'user/tags': { $contains: 'web' } }).map((e) => e.id)).toEqual([2]);
	});

	it('$exists distinguishes null from missing', () => {
		const db = createDatabase();
		db.add(1, 'a', null);
		db.add(2, 'b', 'x');

		expect(db.find({ a: { $exists: true } })).toEqual([{ id: 1, a: null }]);
		expect(db.find({ a: { $exists: false } })).toEqual([{ id: 2, b: 'x' }]);
		expect(db.find({ a: null })).toEqual([{ id: 1, a: null }]);
	});

	it('$ne does not match entities that lack the attribute', () => {
		const db = seeded();
		expect(db.find({ 'user/name': { $ne: 'Alice' } }).map((e) => e.id)).toEqual([2, 3]);
	});

	it('matches Date values by epoch and ref values by target', () => {
		const db = createDatabase();
		const d = new Date(1700000000000);
		db.add(1, 'created', d);
		db.add(2, 'created', new Date(1700000000001));
		db.add(1, 'friend', ref(42));

		expect(db.find({ created: new Date(1700000000000) }).map((e) => e.id)).toEqual([1]);
		expect(db.find({ created: { $lt: new Date(1700000000001) } }).map((e) => e.id)).toEqual([1]);
		expect(db.find({ friend: ref(42) }).map((e) => e.id)).toEqual([1]);
	});

	it('supports id criteria', () => {
		const db = seeded();
		expect(db.find({ id: 2 }).map((e) => e.id)).toEqual([2]);
		expect(db.find({ id: { $in: [1, 3] } }).map((e) => e.id)).toEqual([1, 3]);
	});
});

describe('find — ordering, paging, select', () => {
	it('orders by one attribute and ties break on a second', () => {
		const db = createDatabase();
		db.transact([
			['add', 1, 'user/name', 'A'],
			['add', 1, 'user/age', 30],
			['add', 2, 'user/name', 'B'],
			['add', 2, 'user/age', 20],
			['add', 3, 'user/name', 'C'],
			['add', 3, 'user/age', 30],
			['add', 4, 'user/name', 'D'],
			['add', 4, 'user/age', 10]
		]);

		expect(db.find({ 'user/name': { $exists: true } }, { orderBy: ['user/age', 'desc'] }).map((e) => e.id)).toEqual([
			1, 3, 2, 4
		]);
		expect(
			db.find({ 'user/name': { $exists: true } }, { orderBy: [['user/age', 'asc'], ['user/name', 'desc']] }).map(
				(e) => e.id
			)
		).toEqual([4, 2, 3, 1]);
	});

	it('applies offset and limit after ordering', () => {
		const db = createDatabase();
		db.transact([
			['add', 1, 'n', 3],
			['add', 2, 'n', 1],
			['add', 3, 'n', 2]
		]);

		const page = db.find({ n: { $exists: true } }, { orderBy: ['n', 'asc'], offset: 1, limit: 1 });
		expect(page.map((e) => e.id)).toEqual([3]);
	});

	it('select returns id plus only the requested attributes', () => {
		const db = createDatabase();
		db.transact([
			['add', 1, 'user/name', 'Alice'],
			['add', 1, 'user/age', 30],
			['add', 2, 'user/name', 'Bob']
		]);

		const selected = db.find({ 'user/name': { $exists: true } }, { select: ['user/name'] });
		expect(selected).toEqual([{ id: 1, 'user/name': 'Alice' }, { id: 2, 'user/name': 'Bob' }]);
		expect(Object.isFrozen(selected[0] as object)).toBe(true);
	});

	it('keeps the tx-scoped positional form working', () => {
		const db = createDatabase();
		db.add(1, 'type', 'user');
		db.add(2, 'type', 'user');
		db.retract(2, 'type', 'user');
		expect(db.find({ type: 'user' }, 2).map((e) => e.id)).toEqual([1, 2]);
		expect(db.find({ type: 'user' }).map((e) => e.id)).toEqual([1]);
	});
});

describe('pull — dot-path selection', () => {
	it('pulls scalar attributes by whitespace-separated dot-paths and array form', () => {
		const db = createDatabase();
		const [id] = db.insert([{ 'user/name': 'Alice', 'user/age': 22 }]);

		expect(db.pull(id, 'user.name user.age')).toEqual({ id, 'user/name': 'Alice', 'user/age': 22 });
		expect(db.pull(id, ['user.name', 'user.age'])).toEqual({ id, 'user/name': 'Alice', 'user/age': 22 });
	});

	it('traverses ref attributes into nested objects carrying id', () => {
		const db = createDatabase();
		const [id] = db.insert([
			{ 'user/name': 'Alice', 'user/friend': { 'user/name': 'Bob', 'user/age': 40 } }
		]);

		const pulled = db.pull(id, 'user.name user.friend.user.name user.friend.user.age');
		expect(pulled).toMatchObject({
			id,
			'user/name': 'Alice',
			'user/friend': { 'user/name': 'Bob', 'user/age': 40 }
		});
		const friend = (pulled as { 'user/friend': { id: EntityId } })['user/friend'];
		expect(typeof friend.id).toBe('number');
	});

	it('yields arrays for many-valued refs and merges multiple paths', () => {
		const db = createDatabase();
		const [id] = db.insert([
			{
				'user/name': 'Alice',
				'user/contact': [{ 'contact/type': 'email' }, { 'contact/type': 'phone' }]
			}
		]);

		const pulled = db.pull(id, 'user.name user.contact.contact.type');
		const contacts = (pulled as { 'user/contact': Array<{ id: EntityId; 'contact/type': string }> })['user/contact'];
		expect(contacts).toHaveLength(2);
		expect(contacts.map((c) => c['contact/type'])).toEqual(['email', 'phone']);
		expect(typeof contacts[0]?.id).toBe('number');
	});

	it('returns null for unknown entities', () => {
		const db = createDatabase();
		expect(db.pull(99, 'a.b')).toBeNull();
	});
});

describe('at / diff — time travel', () => {
	it('at(tx) and atTransaction(tx) scope every read to the transaction', () => {
		const db = createDatabase();
		db.add(1, 'name', 'Alice'); // tx 1
		db.add(1, 'age', 22); // tx 2
		db.retract(1, 'age', 22); // tx 3

		expect(db.at(2).entity(1)).toEqual({ id: 1, name: 'Alice', age: 22 });
		expect(db.atTransaction(1).entity(1)).toEqual({ id: 1, name: 'Alice' });
		expect(db.at(1).find({ name: 'Alice' })).toEqual([{ id: 1, name: 'Alice' }]);
		expect(db.at(2).query({ find: ['?e'], where: [['?e', 'age', 22]] })).toEqual([[1]]);
	});

	it('diff returns added and retracted facts between two transactions', () => {
		const db = createDatabase();
describe('datalog query — operators and non-QueryTerm constants', () => {
	it('accepts find operator objects as constrained clauses', () => {
		const db = createDatabase();
		db.add(1, 'age', 20);
		db.add(2, 'age', 30);
		db.add(3, 'age', 40);

		expect(db.query({ find: ['?e'], where: [['?e', 'age', { $gte: 25, $lt: 40 }]] })).toEqual([[2]]);
		expect(db.query({ find: ['?e'], where: [['?e', 'age', { $in: [20, 40] }]] })).toEqual([[1], [3]]);
		expect(db.query({ find: ['?e'], where: [['?e', 'age', { $exists: false }]] })).toEqual([]);
	});

	it('matches Date, BigInt, and ref constants by canonical value key', () => {
		const db = createDatabase();
		const d = new Date(1700000000000);
		db.add(1, 'created', d);
		db.add(2, 'created', new Date(1700000000001));
		db.add(3, 'n', 10n);
		db.add(4, 'friend', ref(5));

		expect(db.query({ find: ['?e'], where: [['?e', 'created', new Date(1700000000000)]] })).toEqual([[1]]);
		expect(db.query({ find: ['?e'], where: [['?e', 'n', 10n]] })).toEqual([[3]]);
		expect(db.query({ find: ['?e'], where: [['?e', 'friend', ref(5)]] })).toEqual([[4]]);
	});

	it('operator clauses join with other clauses', () => {
		const db = createDatabase();
		db.add(1, 'type', 'user');
		db.add(1, 'age', 30);
		db.add(2, 'type', 'user');
		db.add(2, 'age', 10);
		db.add(3, 'type', 'admin');
		db.add(3, 'age', 50);

		expect(
			db.query({
				find: ['?e', '?a'],
				where: [
					['?e', 'type', 'user'],
					['?e', 'age', { $gt: 18 }]
				]
			})
		).toEqual([[1, 30]]);
	});
});

describe('P1 integration round-trip: insert → pull → upsert → diff', () => {
	it('walks the whole authoring surface end to end', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/email', valueType: 'string', cardinality: 'one', unique: 'identity' }]);

		const [alice] = db.insert([
			{
				'user/email': 'a@b.c',
				'user/name': 'Alice',
				'user/address': { 'address/city': 'Berlin', 'address/zip': '10115' }
			}
		]);

		// pull
		const pulled = db.pull(alice, 'user.email user.name user.address.address.city');
		expect(pulled).toMatchObject({ id: alice, 'user/email': 'a@b.c', 'user/name': 'Alice' });
		const addressId = (pulled as { 'user/address': { id: EntityId } })['user/address'].id;

		// upsert by identity adds facts to the same entity
		const matched = db.upsert({ 'user/email': 'a@b.c', 'user/title': 'Dr.' });
		expect(matched).toBe(alice);

		// set emits retract+add in one transaction
		const facts = db.set(alice, { 'user/name': 'Alicia' });
		expect(facts.map((fact) => [fact[2], fact[4]] as const)).toEqual([
			['Alice', 'retract'],
			['Alicia', 'add']
		]);

		// diff sees both sides of the update
		const diff = db.diff(2, db.getTransactions().length);
		expect(diff.added.some((fact) => fact[1] === 'user/name' && fact[2] === 'Alicia')).toBe(true);
		expect(diff.retracted.some((fact) => fact[1] === 'user/name' && fact[2] === 'Alice')).toBe(true);

		// at() time travel sees the inserted state before the update
		expect(db.at(2).entity(alice)).toMatchObject({ 'user/name': 'Alice' });
		expect(db.at(2).pull(alice, 'user.address.address.city')).toMatchObject({
			'user/address': { id: addressId, 'address/city': 'Berlin' }
		});

		// patch the nested entity and observe the change
		db.patch(addressId, { 'address/city': 'Munich' });
		expect(db.pull(alice, 'user.address.address.city')).toMatchObject({
			'user/address': { id: addressId, 'address/city': 'Munich' }
		});
	});
});

		db.add(1, 'name', 'Alice'); // tx 1
		db.add(1, 'age', 22); // tx 2
		db.set(1, 'name', 'Alicia'); // tx 3: retract Alice + add Alicia

		const diff: DiffResult = db.diff(1, 3);
		expect(diff.added.map((fact) => [fact[1], fact[2]] as const)).toEqual([
			['age', 22],
			['name', 'Alicia']
		]);
		expect(diff.retracted.map((fact) => [fact[1], fact[2]] as const)).toEqual([['name', 'Alice']]);
		expect(db.diff(3, 1)).toEqual(diff); // order-insensitive
		expect(db.diff(3, 3)).toEqual({ added: [], retracted: [] });
	});
});

