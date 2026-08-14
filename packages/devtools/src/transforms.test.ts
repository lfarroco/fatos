import { describe, expect, it } from 'vitest';
import { createDatabase, lookupRef, ref } from '@fatos/core';
import type { Fact, TransactionRecord } from '@fatos/client';
import {
	buildScopedSnapshot,
	computeDiff,
	computeTimeline,
	factsAtOrBefore,
	filterFacts,
	formatValue,
	groupFactsByEntity,
	stableValueKey,
	transactionsAtOrBefore
} from './transforms';
import type { FactSnapshot } from './snapshot';

describe('groupFactsByEntity', () => {
	it('groups facts by entity preserving order', () => {
		const facts: Fact[] = [
			[1, 'name', 'Alice', 1, 'add'],
			[2, 'name', 'Bob', 1, 'add'],
			[1, 'age', 30, 2, 'add']
		];

		const groups = groupFactsByEntity(facts);
		expect([...groups.keys()]).toEqual([1, 2]);
		expect(groups.get(1)).toEqual([facts[0], facts[2]]);
		expect(groups.get(2)).toEqual([facts[1]]);
	});

	it('handles string entity ids and empty input', () => {
		const facts: Fact[] = [['user:1', 'name', 'Alice', 1, 'add']];
		expect([...groupFactsByEntity(facts).keys()]).toEqual(['user:1']);
		expect(groupFactsByEntity([]).size).toBe(0);
	});
});

describe('computeTimeline', () => {
	it('builds tx/timestamp/factCount/metadata entries', () => {
		const transactions: TransactionRecord[] = [
			[1, 1000, { source: 'ui' }],
			[2, 2000, null]
		];
		const facts: Fact[] = [
			[1, 'a', 'x', 1, 'add'],
			[1, 'b', 'y', 1, 'add'],
			[2, 'a', 'z', 2, 'add']
		];

		expect(computeTimeline(transactions, facts)).toEqual([
			{ tx: 1, timestamp: 1000, factCount: 2, metadata: { source: 'ui' } },
			{ tx: 2, timestamp: 2000, factCount: 1, metadata: null }
		]);
	});

	it('reports zero fact counts when the fact log is omitted', () => {
		const transactions: TransactionRecord[] = [[1, 1000, null]];
		expect(computeTimeline(transactions)[0].factCount).toBe(0);
	});
});

describe('computeDiff', () => {
	it('wraps core db.diff for transaction ranges', () => {
		const db = createDatabase();
		db.add(1, 'name', 'Alice'); // tx 1
		db.add(1, 'age', 30); // tx 2
		db.retract(1, 'name', 'Alice'); // tx 3
		db.add(1, 'name', 'Alicia'); // tx 4

		const diff = computeDiff(2, 4, db);
		expect(diff).toEqual(db.diff(2, 4));
		expect(diff.added.map((fact) => fact[2])).toContain('Alicia');
		expect(diff.retracted.map((fact) => fact[2])).toContain('Alice');
	});

	it('diffs two fact-log snapshots by fact identity', () => {
		const a: Fact[] = [
			[1, 'name', 'Alice', 1, 'add'],
			[1, 'age', 30, 2, 'add']
		];
		const b: Fact[] = [
			[1, 'name', 'Alice', 1, 'add'],
			[1, 'name', 'Alicia', 3, 'add']
		];

		const diff = computeDiff(a, b);
		expect(diff.added).toEqual([b[1]]);
		expect(diff.retracted).toEqual([a[1]]);
	});

	it('returns empty diffs for identical logs', () => {
		const facts: Fact[] = [[1, 'name', 'Alice', 1, 'add']];
		expect(computeDiff(facts, facts)).toEqual({ added: [], retracted: [] });
	});
});

describe('formatValue', () => {
	it('formats primitives, dates, bigints, and collections', () => {
		expect(formatValue(null)).toBe('null');
		expect(formatValue('hi')).toBe('hi');
		expect(formatValue(42)).toBe('42');
		expect(formatValue(true)).toBe('true');
		expect(formatValue(123n)).toBe('123n');
		expect(formatValue(new Date(0))).toBe('1970-01-01T00:00:00.000Z');
		expect(formatValue(['a', 1])).toBe('[a, 1]');
		expect(formatValue({ a: 1 })).toBe('{"a":1}');
		expect(formatValue(undefined)).toBe('undefined');
	});

	it('formats branded refs', () => {
		expect(formatValue(ref(5))).toBe('#5');
		expect(formatValue(lookupRef(['user/email', 'a@b.c']))).toBe('[user/email a@b.c]');
	});
});

describe('filterFacts', () => {
	const facts: Fact[] = [
		[1, 'name', 'Alice', 1, 'add'],
		[1, 'age', 30, 2, 'add'],
		[2, 'name', 'Bob', 3, 'add'],
		[2, 'name', 'Bob', 4, 'retract']
	];

	it('filters by entity, attribute, tx, and op', () => {
		expect(filterFacts(facts, { entity: 1 })).toEqual([facts[0], facts[1]]);
		expect(filterFacts(facts, { attribute: 'name' })).toEqual([facts[0], facts[2], facts[3]]);
		expect(filterFacts(facts, { tx: 3 })).toEqual([facts[2]]);
		expect(filterFacts(facts, { op: 'retract' })).toEqual([facts[3]]);
		expect(filterFacts(facts, { entity: 2, op: 'add' })).toEqual([facts[2]]);
	});

	it('returns the input unchanged with an empty filter', () => {
		expect(filterFacts(facts)).toEqual(facts);
	});
});

describe('stableValueKey', () => {
	it('keys equal values identically and distinguishes types', () => {
		expect(stableValueKey(10)).toBe(stableValueKey(10));
		expect(stableValueKey(10)).not.toBe(stableValueKey('10'));
		expect(stableValueKey(10n)).not.toBe(stableValueKey(10));
		expect(stableValueKey(new Date(5))).toBe(stableValueKey(new Date(5)));
		expect(stableValueKey(ref(5))).toBe(stableValueKey(ref(5)));
		expect(stableValueKey(ref(5))).not.toBe(stableValueKey(ref(6)));
		expect(stableValueKey(['a', 1])).toBe(stableValueKey(['a', 1]));
	});
});

describe('factsAtOrBefore / transactionsAtOrBefore', () => {
	const facts: Fact[] = [
		[1, 'a', 'x', 1, 'add'],
		[1, 'b', 'y', 2, 'add'],
		[2, 'a', 'z', 3, 'add']
	];
	const transactions: TransactionRecord[] = [
		[1, 100, null],
		[2, 200, null],
		[3, 300, null]
	];

	it('keeps only facts and transactions at or before the tx', () => {
		expect(factsAtOrBefore(facts, 2)).toEqual([facts[0], facts[1]]);
		expect(transactionsAtOrBefore(transactions, 2)).toEqual([transactions[0], transactions[1]]);
	});

	it('clamps naturally at the ends of the log', () => {
		expect(factsAtOrBefore(facts, 0)).toEqual([]);
		expect(transactionsAtOrBefore(transactions, 0)).toEqual([]);
		expect(factsAtOrBefore(facts, 99)).toEqual(facts);
		expect(transactionsAtOrBefore(transactions, 99)).toEqual(transactions);
	});
});

describe('buildScopedSnapshot', () => {
	const snapshot: FactSnapshot = {
		facts: [
			[1, 'name', 'Alice', 1, 'add'],
			[1, 'age', 30, 2, 'add'],
			[1, 'age', 30, 3, 'retract'],
			[1, 'age', 31, 4, 'add']
		],
		transactions: [
			[1, 1000, null],
			[2, 2000, null],
			[3, 3000, null],
			[4, 4000, null]
		],
		url: 'https://example.test/'
	};

	it('scopes both facts and transactions to the tx', () => {
		const scoped = buildScopedSnapshot(snapshot, 2);
		expect(scoped.facts).toEqual([snapshot.facts[0], snapshot.facts[1]]);
		expect(scoped.transactions).toEqual([snapshot.transactions[0], snapshot.transactions[1]]);
		expect(scoped.url).toBe('https://example.test/');
	});

	it('produces a snapshot that restore() accepts (tx sets still match)', () => {
		const db = createDatabase();
		db.restore(buildScopedSnapshot(snapshot, 3));
		expect(db.getFacts()).toEqual([snapshot.facts[0], snapshot.facts[1], snapshot.facts[2]]);
		expect(db.getTransactions()).toHaveLength(3);
	});
});
