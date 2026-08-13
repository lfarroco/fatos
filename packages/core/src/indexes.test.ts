/**
 * Unit tests: EAVT / AEVT / AVET index lookups and result isolation.
 */

import { describe, it, expect } from 'vitest';
import { createDatabase } from './index';

describe('index lookups', () => {
	it('getFactsByEntity returns only facts for that entity, ordered by tx', () => {
		const db = createDatabase();
		db.add(1, 'a', 'x');
		db.add(2, 'a', 'x');
		db.add(1, 'b', 'y');
		expect(db.getFactsByEntity(1)).toEqual([
			[1, 'a', 'x', 1, 'add'],
			[1, 'b', 'y', 3, 'add']
		]);
		expect(db.getFactsByEntity(99)).toEqual([]);
	});

	it('getFactsByAttribute returns only facts for that attribute', () => {
		const db = createDatabase();
		db.add(1, 'a', 1);
		db.add(2, 'b', 1);
		db.add(3, 'a', 2);
		expect(db.getFactsByAttribute('a')).toEqual([
			[1, 'a', 1, 1, 'add'],
			[3, 'a', 2, 3, 'add']
		]);
		expect(db.getFactsByAttribute('zz')).toEqual([]);
	});

	it('getFactsByEntityAttribute scopes by both', () => {
		const db = createDatabase();
		db.add(1, 'a', 1);
		db.add(1, 'b', 2);
		db.add(2, 'a', 3);
		expect(db.getFactsByEntityAttribute(1, 'a')).toEqual([[1, 'a', 1, 1, 'add']]);
		expect(db.getFactsByEntityAttribute(2, 'a')).toEqual([[2, 'a', 3, 3, 'add']]);
	});

	it('getFactsByAttributeValue finds facts by exact value', () => {
		const db = createDatabase();
		db.add(1, 'a', 'x');
		db.add(2, 'a', 'y');
		db.add(3, 'b', 'x');
		expect(db.getFactsByAttributeValue('a', 'x')).toEqual([[1, 'a', 'x', 1, 'add']]);
		expect(db.getFactsByAttributeValue('a', 'nope')).toEqual([]);
	});

	it('handles null and boolean values in the AVET index', () => {
		const db = createDatabase();
		db.add(1, 'flag', true);
		db.add(2, 'flag', false);
		db.add(3, 'flag', null);
		expect(db.getFactsByAttributeValue('flag', true)).toEqual([[1, 'flag', true, 1, 'add']]);
		expect(db.getFactsByAttributeValue('flag', false)).toEqual([[2, 'flag', false, 2, 'add']]);
		expect(db.getFactsByAttributeValue('flag', null)).toEqual([[3, 'flag', null, 3, 'add']]);
	});

	it('returns copies that cannot corrupt the database', () => {
		const db = createDatabase();
		db.add(1, 'a', 'x');
		const facts = db.getFacts();
		facts.push([9, 'hack', 9, 9, 'add']);
		expect(db.getFacts()).toEqual([[1, 'a', 'x', 1, 'add']]);

		const byEntity = db.getFactsByEntity(1);
		byEntity.length = 0;
		expect(db.getFactsByEntity(1)).toHaveLength(1);
	});
});

describe('known limitations (pinned current behavior)', () => {
	it('collides -0 and +0 in the AVET value key (see design/02, P0)', () => {
		const db = createDatabase();
		db.add(1, 'n', -0);
		// KNOWN LIMITATION: valueKey uses String(value), so -0 and +0 share a key.
		const result = db.getFactsByAttributeValue('n', 0);
		expect(result).toHaveLength(1);
		expect(result[0]?.[0]).toBe(1);
		expect(Object.is(result[0]?.[2], -0)).toBe(true);
		expect(db.getFactsByAttributeValue('n', -0)).toHaveLength(1);
	});
});
