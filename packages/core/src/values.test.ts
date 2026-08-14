/**
 * Unit tests: P0 value model — ref()/temp()/lookupRef() helpers, tempid
 * resolution at commit, Date/BigInt values, value validation (NaN/Infinity,
 * opaque objects), and db/unique + db/ref schema support (design/01).
 */

import { describe, it, expect } from 'vitest';
import {
	createDatabase,
	isLookupRef,
	isRef,
	isTemp,
	lookupRef,
	ref,
	temp,
	LOOKUP_REF_BRAND,
	REF_BRAND,
	TEMP_BRAND,
	type Fact,
	type Ref
} from './index';

describe('value helpers', () => {
	it('ref() brands entity ids; a plain number is never a reference', () => {
		expect(isRef(42)).toBe(false);
		expect(isRef(ref(42))).toBe(true);
		expect(ref(42)[REF_BRAND]).toBe(42);
		expect(ref('user:1')[REF_BRAND]).toBe('user:1');
		expect(isRef(ref(temp('t')))).toBe(true);
		expect(isRef(ref(lookupRef(['user/email', 'a@b.c'])))).toBe(true);
	});

	it('ref() rejects opaque targets', () => {
		expect(() => ref({} as never)).toThrow(/ref\(\)/);
		expect(() => ref(NaN)).toThrow(/ref\(\)/);
		expect(() => ref(undefined as never)).toThrow(/ref\(\)/);
	});

	it('temp() returns branded handles; same label aliases, bare calls differ', () => {
		const first = temp('user');
		const second = temp('user');
		expect(isTemp(first)).toBe(true);
		expect(first[TEMP_BRAND]).toBe('user');
		expect(first[TEMP_BRAND]).toBe(second[TEMP_BRAND]);
		expect(temp()[TEMP_BRAND]).not.toBe(temp()[TEMP_BRAND]);
	});

	it('lookupRef() brands unique lookups and validates its input', () => {
		const lookup = lookupRef(['user/email', 'a@b.c']);
		expect(isLookupRef(lookup)).toBe(true);
		expect(lookup[LOOKUP_REF_BRAND]).toEqual(['user/email', 'a@b.c']);
		expect(() => lookupRef(['user/email', {} as never])).toThrow(/lookupRef/);
	});
});

describe('tempid resolution at commit', () => {
	it('aliases repeated negative ids and temp() handles within one transaction', () => {
		const db = createDatabase();
		const facts = db.transact([
			['add', -1, 'name', 'Negative'],
			['add', -1, 'age', 1],
			['add', temp('alice'), 'name', 'Handle']
		]);

		expect(facts[0]?.[0]).toBe(facts[1]?.[0]); // -1 aliased
		expect(facts[0]?.[0]).toBeGreaterThan(0);
		expect(facts[2]?.[0]).toBeGreaterThan(0);
		expect(facts[0]?.[0]).not.toBe(facts[2]?.[0]); // -1 and temp('alice') differ

		const negativeEid = facts[0]?.[0] as number;
		const handleEid = facts[2]?.[0] as number;
		expect(db.entity(negativeEid)).toEqual({ id: negativeEid, name: 'Negative', age: 1 });
		expect(db.entity(handleEid)).toEqual({ id: handleEid, name: 'Handle' });

		// no tempids anywhere in committed facts
		for (const fact of db.getFacts()) {
			expect(fact[0]).toBeGreaterThan(0);
			expect(isTemp(fact[0])).toBe(false);
			expect(isTemp(fact[2])).toBe(false);
		}
	});

	it('resolves ref(temp()) and ref(negative) to the same entity the tempid created', () => {
		const db = createDatabase();
		const t = temp('friend');
		const facts = db.transact([
			['add', t, 'name', 'Bob'],
			['add', 7, 'friend', ref(t)],
			['add', 8, 'friend', ref(-5)],
			['add', -5, 'name', 'Carol']
		]);

		const bobEid = facts[0]?.[0] as number;
		const carolEid = facts[3]?.[0] as number;
		expect((facts[1]?.[2] as Ref)[REF_BRAND]).toBe(bobEid);
		expect((facts[2]?.[2] as Ref)[REF_BRAND]).toBe(carolEid);
	});

	it('assigns fresh ids that skip existing entity ids', () => {
		const db = createDatabase();
		db.add(1, 'name', 'taken');
		const facts = db.transact([['add', -1, 'name', 'new']]);
		expect(facts[0]?.[0]).toBe(2);
	});

	it('resolves the same tempid to different entities in different transactions', () => {
		const db = createDatabase();
		const first = db.transact([['add', -1, 'name', 'a']]);
		const second = db.transact([['add', -1, 'name', 'b']]);
		expect(first[0]?.[0]).not.toBe(second[0]?.[0]);
	});

	it('rejects a bare temp() in value position', () => {
		const db = createDatabase();
		expect(() => db.add(1, 'friend', temp('x'))).toThrow(/ref\(\)/);
		expect(() => db.transact([['add', 1, 'friend', temp('x')]])).toThrow(/ref\(\)/);
	});

	it('keeps returning Fact[] from transact with resolved ids', () => {
		const db = createDatabase();
		const facts = db.transact([['add', -1, 'name', 'x']]);
		expect(facts).toHaveLength(1);
		expect(Array.isArray(facts[0])).toBe(true);
		expect((facts[0] as Fact)[0]).toBeGreaterThan(0);
	});
});


describe('Date and BigInt values', () => {
	it('round-trips Date through entity and find (indexed by ms epoch)', () => {
		const db = createDatabase();
		const date = new Date(1_700_000_000_000);
		db.add(1, 'created', date);
		expect(db.entity(1)).toEqual({ id: 1, created: date });
		expect(db.find({ created: new Date(1_700_000_000_000) })).toEqual([{ id: 1, created: date }]);
		expect(db.getFactsByAttributeValue('created', new Date(1_700_000_000_000))).toHaveLength(1);
	});

	it('round-trips BigInt through entity and find', () => {
		const db = createDatabase();
		const big = 9_007_199_254_740_993n;
		db.add(1, 'big', big);
		expect(db.entity(1)).toEqual({ id: 1, big });
		expect(db.find({ big: 9_007_199_254_740_993n })).toEqual([{ id: 1, big }]);
	});

	it('dedupes equal-ms Dates in cardinality-many attributes', () => {
		const db = createDatabase();
		db.transact([{ ident: 'events/at', valueType: 'date', cardinality: 'many' }]);
		db.transact([
			['add', 1, 'events/at', new Date(1000)],
			['add', 1, 'events/at', new Date(1000)],
			['add', 1, 'events/at', new Date(2000)]
		]);
		expect(db.entity(1)).toEqual({ id: 1, 'events/at': [new Date(1000), new Date(2000)] });
	});

	it('enforces date and bigint value types from schema', () => {
		const db = createDatabase();
		db.transact([
			{ ident: 'd/at', valueType: 'date', cardinality: 'one' },
			{ ident: 'b/n', valueType: 'bigint', cardinality: 'one' }
		]);
		db.add(1, 'd/at', new Date());
		db.add(1, 'b/n', 10n);
		expect(() => db.add(1, 'd/at', 1000)).toThrow(/Invalid value type/);
		expect(() => db.add(1, 'b/n', 10)).toThrow(/Invalid value type/);
	});
});

describe('value validation at commit', () => {
	it('rejects NaN and ±Infinity numbers', () => {
		const db = createDatabase();
		expect(() => db.add(1, 'n', NaN)).toThrow(/NaN/);
		expect(() => db.add(1, 'n', Number.POSITIVE_INFINITY)).toThrow(/NaN/);
		expect(() => db.add(1, 'n', Number.NEGATIVE_INFINITY)).toThrow(/NaN/);
		expect(() => db.transact([['add', 2, 'n', NaN]])).toThrow(/NaN/);
		expect(db.getFacts()).toHaveLength(0);
	});

	it('rejects opaque object values', () => {
		const db = createDatabase();
		expect(() => db.add(1, 'payload', { x: 1 })).toThrow(/opaque objects/);
		expect(() => db.add(1, 'payload', new Date(0))).not.toThrow(); // Date is a supported object
		expect(() => db.retract(1, 'payload', { nested: true })).toThrow(/opaque objects/);
		expect(() => db.transact([['add', 2, 'payload', { a: [1] }]])).toThrow(/opaque objects/);
		expect(db.getFacts()).toHaveLength(1); // only the Date add
	});

	it('rejects invalid Dates', () => {
		const db = createDatabase();
		expect(() => db.add(1, 'd', new Date(Number.NaN))).toThrow(/date/);
	});

	it('keeps accepting arrays verbatim (cardinality-many expansion is P1)', () => {
		const db = createDatabase();
		db.add(1, 'tags', ['a', 'b']);
		expect(db.entity(1)).toEqual({ id: 1, tags: ['a', 'b'] });
	});

	it('rejects undefined and functions', () => {
		const db = createDatabase();
		expect(() => db.add(1, 'a', undefined)).toThrow(/undefined/);
		expect(() => db.add(1, 'a', () => 1)).toThrow(/function/);
	});

describe('db/unique schema support', () => {
	it('stores and exposes unique (identity and value) via getSchema/getSchemas', () => {
		const db = createDatabase();
		db.transact([
			{ ident: 'user/email', valueType: 'string', cardinality: 'one', unique: 'value' },
			{ ident: 'user/slug', valueType: 'string', cardinality: 'one', unique: 'identity' }
		]);
		expect(db.getSchema('user/email')?.unique).toBe('value');
		expect(db.getSchema('user/slug')?.unique).toBe('identity');
		expect(db.getSchema('user/email')?.ref).toBeUndefined();
		expect(db.getSchemas().find((s) => s.ident === 'user/email')?.unique).toBe('value');
		expect(db.getFactsByAttribute('db/unique')).toHaveLength(2);
	});

	it("unique 'value' rejects duplicate values across entities", () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/email', valueType: 'string', cardinality: 'one', unique: 'value' }]);
		db.add(1, 'user/email', 'a@b.c');
		expect(() => db.add(2, 'user/email', 'a@b.c')).toThrow(/Unique constraint violation/);
		db.add(1, 'user/email', 'a@b.c'); // same-entity re-add is a no-op
	});

	it("unique 'value' rejects duplicates within the same transaction", () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/email', valueType: 'string', cardinality: 'one', unique: 'value' }]);
		expect(() =>
			db.transact([
				['add', 1, 'user/email', 'dup@x'],
				['add', 2, 'user/email', 'dup@x']
			])
		).toThrow(/Unique constraint violation/);
		expect(db.getFacts()).toHaveLength(4); // 3 schema facts + db/unique
	});

	it("unique 'value' frees the value on retract", () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/email', valueType: 'string', cardinality: 'one', unique: 'value' }]);
		db.add(1, 'user/email', 'a@b.c');
		db.retract(1, 'user/email', 'a@b.c');
		db.add(2, 'user/email', 'a@b.c');
		expect(db.entity(2)).toEqual({ id: 2, 'user/email': 'a@b.c' });
	});

	it('can add unique to an already-declared attribute (schema is data)', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/email', valueType: 'string', cardinality: 'one' }]);
		const facts = db.transact([
			{ ident: 'user/email', valueType: 'string', cardinality: 'one', unique: 'value' }
		]);
		expect(facts).toEqual([[-1, 'db/unique', 'value', 2, 'add']]);
		expect(db.getSchema('user/email')?.unique).toBe('value');
	});

	it('rejects conflicting unique redeclarations', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/email', valueType: 'string', cardinality: 'one', unique: 'value' }]);
		expect(() =>
			db.transact([{ ident: 'user/email', valueType: 'string', cardinality: 'one', unique: 'identity' }])
		).toThrow(/Schema conflict/);
	});
});

describe('db/ref schema support', () => {
	it('stores and exposes ref via getSchema', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/manager', valueType: 'ref', cardinality: 'one', ref: true }]);
		expect(db.getSchema('user/manager')?.valueType).toBe('ref');
		expect(db.getSchema('user/manager')?.ref).toBe(true);
		expect(db.getFactsByAttribute('db/ref')).toHaveLength(1);
	});

	it('enforces ref()/lookupRef() values for valueType ref', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/manager', valueType: 'ref', cardinality: 'one' }]);
		db.add(1, 'user/manager', ref(2));
		expect(() => db.add(1, 'user/manager', 2)).toThrow(/Invalid value type/);
		expect(() => db.add(1, 'user/manager', 'bob')).toThrow(/Invalid value type/);
	});

	it('enforces ref()/lookupRef() values when db/ref is true', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/manager', valueType: 'unknown', cardinality: 'one', ref: true }]);
		db.add(1, 'user/manager', ref(2));
		expect(() => db.add(1, 'user/manager', 'bob')).toThrow(/ref\(\) or lookupRef\(\)/);
		db.add(2, 'user/manager', lookupRef(['user/email', 'a@b.c'])); // allowed
		expect(isLookupRef((db.entity(2) as { 'user/manager': unknown })['user/manager'])).toBe(true);
	});

	it('rejects conflicting ref redeclarations', () => {
		const db = createDatabase();
		db.transact([{ ident: 'user/manager', valueType: 'unknown', cardinality: 'one', ref: true }]);
		expect(() =>
			db.transact([{ ident: 'user/manager', valueType: 'unknown', cardinality: 'one', ref: false }])
		).toThrow(/Schema conflict/);
	});
});

describe('ref() round-trip', () => {
	it('stores and returns branded ref values from entity', () => {
		const db = createDatabase();
		db.add(1, 'friend', ref(42));
		const entity = db.entity(1) as { id: number; friend: Ref };
		expect(isRef(entity.friend)).toBe(true);
		expect(entity.friend[REF_BRAND]).toBe(42);
	});

	it('stores lookupRef values as-is (resolved by upsert in P1)', () => {
		const db = createDatabase();
		const lookup = lookupRef(['user/email', 'a@b.c']);
		db.add(1, 'manager', lookup);
		const entity = db.entity(1) as { id: number; manager: typeof lookup };
		expect(isLookupRef(entity.manager)).toBe(true);
		expect(entity.manager[LOOKUP_REF_BRAND]).toEqual(['user/email', 'a@b.c']);
	});

	it('find matches ref values by target', () => {
		const db = createDatabase();
		db.add(1, 'friend', ref(42));
		db.add(2, 'friend', ref(43));
		expect(db.find({ friend: ref(42) })).toEqual([{ id: 1, friend: ref(42) }]);
	});
});

});
