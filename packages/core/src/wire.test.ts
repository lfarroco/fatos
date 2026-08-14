/**
 * Unit tests: P3 wire protocol — JSON type tags for Date/BigInt/ref/lookupRef
 * values, the inverse reviver, wire-form QuerySpec deserialization, and
 * round-trips through actual engine facts (design/01, design/03).
 */

import { describe, it, expect } from 'vitest';
import {
	createDatabase,
	deserializeQuerySpec,
	deserializeValue,
	isLookupRef,
	isRef,
	lookupRef,
	ref,
	serializeValue,
	temp,
	LOOKUP_REF_BRAND,
	REF_BRAND,
	type Fact
} from './index';

/** Serializes to JSON text and back, the way a REST/WS transport would. */
function wireRoundTrip(value: unknown): unknown {
	return deserializeValue(JSON.parse(JSON.stringify(serializeValue(value))) as unknown);
}

describe('serializeValue — JSON type tags (P3)', () => {
	it('tags ref() targets as { $ref: id }', () => {
		expect(serializeValue(ref(42))).toEqual({ $ref: 42 });
		expect(serializeValue(ref('user:1'))).toEqual({ $ref: 'user:1' });
	});

	it('tags lookupRef() as { $lookupRef: [attribute, value] }', () => {
		expect(serializeValue(lookupRef(['user/email', 'a@b.c']))).toEqual({
			$lookupRef: ['user/email', 'a@b.c']
		});
	});

	it('tags ref(lookupRef(...)) as a nested lookup', () => {
		expect(serializeValue(ref(lookupRef(['user/email', 'a@b.c'])))).toEqual({
			$ref: { $lookupRef: ['user/email', 'a@b.c'] }
		});
	});

	it('tags Date by ms epoch and BigInt by its string form', () => {
		expect(serializeValue(new Date(1700000000000))).toEqual({ $date: 1700000000000 });
		expect(serializeValue(9007199254740993n)).toEqual({ $bigint: '9007199254740993' });
	});

	it('passes scalars through as plain JSON', () => {
		expect(serializeValue('x')).toBe('x');
		expect(serializeValue(7)).toBe(7);
		expect(serializeValue(true)).toBe(true);
		expect(serializeValue(null)).toBeNull();
		expect(serializeValue(undefined)).toBeUndefined();
	});

	it('serializes arrays element-wise', () => {
		expect(serializeValue([ref(1), new Date(2), 'x'])).toEqual([{ $ref: 1 }, { $date: 2 }, 'x']);
	});

	it('throws when asked to serialize an unresolved temp()', () => {
		expect(() => serializeValue(temp('t'))).toThrow(/temp\(\)/);
		expect(() => serializeValue(ref(temp('t')))).toThrow(/temp\(\)/);
	});
});


describe('deserializeValue — inverse reviver (P3)', () => {
	it('revives { $date } to a Date', () => {
		const revived = deserializeValue({ $date: 1700000000000 });
		expect(revived).toBeInstanceOf(Date);
		expect((revived as Date).getTime()).toBe(1700000000000);
	});

	it('revives { $bigint } to a BigInt', () => {
		expect(deserializeValue({ $bigint: '9007199254740993' })).toBe(9007199254740993n);
	});

	it('revives { $ref } to a ref() and { $lookupRef } to a lookupRef()', () => {
		const revivedRef = deserializeValue({ $ref: 42 }) as { [REF_BRAND]: unknown };
		expect(isRef(revivedRef)).toBe(true);
		expect(revivedRef[REF_BRAND]).toBe(42);

		const revivedLookup = deserializeValue({ $lookupRef: ['user/email', 'a@b.c'] });
		expect(isLookupRef(revivedLookup)).toBe(true);
	});

	it('revives nested { $ref: { $lookupRef: ... } } targets', () => {
		const revived = deserializeValue({ $ref: { $lookupRef: ['user/email', 'a@b.c'] } }) as {
			[REF_BRAND]: unknown;
		};
		expect(isRef(revived)).toBe(true);
		expect(isLookupRef(revived[REF_BRAND])).toBe(true);
	});

	it('revives tagged values inside arrays', () => {
		const revived = deserializeValue([{ $date: 1 }, { $ref: 2 }]) as unknown[];
		expect(revived[0]).toBeInstanceOf(Date);
		expect(isRef(revived[1])).toBe(true);
	});

	it('rejects malformed tags', () => {
		expect(() => deserializeValue({ $ref: {} })).toThrow(/Invalid \$ref/);
		expect(() => deserializeValue({ $lookupRef: [42, 'x'] })).toThrow(/Invalid \$lookupRef/);
		expect(() => deserializeValue({ $bigint: 'not-a-number' })).toThrow();
	});

	it('leaves plain JSON untouched', () => {
		const plain = { nested: { a: [1, 2] }, n: 3 };
		expect(deserializeValue(plain)).toEqual(plain);
	});
});

describe('wire round-trip (serialize -> JSON -> deserialize)', () => {
	it('round-trips every tagged value', () => {
		expect(wireRoundTrip(new Date(1700000000000))).toEqual(new Date(1700000000000));
		expect(wireRoundTrip(9007199254740993n)).toBe(9007199254740993n);
		expect(wireRoundTrip(ref(42))).toEqual(ref(42));
		expect(wireRoundTrip(lookupRef(['user/email', 'a@b.c']))).toEqual(
			lookupRef(['user/email', 'a@b.c'])
		);
		expect(wireRoundTrip(ref(lookupRef(['user/email', 'a@b.c'])))).toEqual(
			ref(lookupRef(['user/email', 'a@b.c']))
		);
		expect(wireRoundTrip([ref(1), new Date(2), 'x'])).toEqual([ref(1), new Date(2), 'x']);
	});
});

describe('deserializeQuerySpec — wire-form datalog specs (P3)', () => {
	it('revives tagged constants in where clauses', () => {
		const spec = deserializeQuerySpec({
			find: ['?e', '?v'],
			where: [
				['?e', 'user/born', { $date: 1700000000000 }],
				['?e', 'user/serial', { $bigint: '9007199254740993' }],
				['?e', 'user/manager', { $ref: 42 }],
				['?e', 'user/email', { $lookupRef: ['user/email', 'a@b.c'] }]
			]
		});

		expect(spec.where[0]?.[2]).toEqual(new Date(1700000000000));
		expect(spec.where[1]?.[2]).toBe(9007199254740993n);
		expect(isRef(spec.where[2]?.[2])).toBe(true);
		expect(isLookupRef(spec.where[3]?.[2])).toBe(true);
	});

	it('revives tagged values inside find operators', () => {
		const spec = deserializeQuerySpec({
			find: ['?e'],
			where: [['?e', 'user/born', { $in: [{ $date: 1 }, { $date: 2 }] }]]
		});

		const operator = spec.where[0]?.[2] as { $in: unknown[] };
		expect(operator.$in).toEqual([new Date(1), new Date(2)]);
	});

	it('keeps plain specs as-is', () => {
		const spec = deserializeQuerySpec({
			find: ['?e', '?name'],
			where: [
				['?e', 'type', 'user'],
				['?e', 'name', '?name']
			]
		});

		expect(spec).toEqual({
			find: ['?e', '?name'],
			where: [
				['?e', 'type', 'user'],
				['?e', 'name', '?name']
			]
		});
	});

	it('rejects malformed specs', () => {
		expect(() => deserializeQuerySpec({})).toThrow(/Invalid QuerySpec/);
		expect(() => deserializeQuerySpec({ find: ['?e'], where: [['?e', 42, 'x']] })).toThrow(
			/Invalid QuerySpec/
		);
	});
});

describe('engine round-trip through committed facts (P3)', () => {
	it('serializes committed Date/ref values and revives them after a JSON pass', () => {
		const db = createDatabase();
		db.transact([
			['add', 1, 'user/born', new Date(1700000000000)],
			['add', 1, 'user/manager', ref(42)],
			['add', 1, 'user/serial', 9007199254740993n]
		]);

		const wireFacts = db.getFacts().map((fact) => serializeValue(fact)) as Fact[];
		const revived = deserializeValue(JSON.parse(JSON.stringify(wireFacts)) as unknown) as Fact[];

		expect(revived[0]?.[2]).toEqual(new Date(1700000000000));
		expect(isRef(revived[1]?.[2])).toBe(true);
		expect(revived[2]?.[2]).toBe(9007199254740993n);
	});

	it('serializes array values element-wise through a fact', () => {
		const db = createDatabase();
		db.add(1, 'user/tags', [ref(1), new Date(3)]);

		const wire = serializeValue(db.getFacts()[0] as Fact);
		expect(wire).toEqual([1, 'user/tags', [{ $ref: 1 }, { $date: 3 }], 1, 'add']);
	});

	it('survives a full JSON pass through committed facts', () => {
		const db = createDatabase();
		db.transact([
			['add', 1, 'user/born', new Date(1700000000000)],
			['add', 1, 'user/manager', ref(42)],
			['add', 1, 'user/serial', 9007199254740993n]
		]);

		const roundTripped = wireRoundTrip(db.getFacts()) as Fact[];
		expect(roundTripped).toHaveLength(3);
		expect(roundTripped[0][2]).toEqual(new Date(1700000000000));
		expect(isRef(roundTripped[1][2])).toBe(true);
		expect(roundTripped[2][2]).toBe(9007199254740993n);
	});

	it('round-trips a lookupRef stored on a unique identity attribute', () => {
		const db = createDatabase();
		const lookup = lookupRef(['user/email', 'a@b.c']);
		db.add(1, 'user/email', 'a@b.c');
		db.add(2, 'user/manager', lookup);

		const revived = wireRoundTrip(db.getFacts()[1] as Fact) as Fact;
		expect(isLookupRef(revived[2])).toBe(true);
		expect((revived[2] as { [LOOKUP_REF_BRAND]: readonly [string, unknown] })[LOOKUP_REF_BRAND]).toEqual([
			'user/email',
			'a@b.c'
		]);
	});
});
