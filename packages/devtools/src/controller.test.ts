import { describe, expect, it, vi } from 'vitest';
import { createDatabase } from '@fatos/core';
import type { QuerySpec } from '@fatos/client';
import { DevtoolsPanelController } from './controller';
import type { FactSnapshot } from './snapshot';

function buildSnapshot(): FactSnapshot {
	const db = createDatabase();
	db.add(1, 'user/name', 'Alice'); // tx 1
	db.add(1, 'user/age', 30); // tx 2
	db.add(2, 'user/name', 'Bob'); // tx 3
	db.retract(1, 'user/age', 30); // tx 4
	db.add(1, 'user/age', 31); // tx 5
	return {
		facts: [...db.getFacts()],
		transactions: [...db.getTransactions()],
		url: 'https://example.test/'
	};
}

const nameQuery: QuerySpec = {
	find: ['?e', '?name'],
	where: [['?e', 'user/name', '?name']]
};

describe('DevtoolsPanelController', () => {
	it('starts without a snapshot and degrades gracefully', () => {
		const controller = new DevtoolsPanelController();
		expect(controller.hasSnapshot()).toBe(false);
		expect(controller.getFacts()).toEqual([]);
		expect(controller.getTransactions()).toEqual([]);
		expect(controller.getDiff(1, 2)).toBeNull();
		expect(controller.runQuery(nameQuery)).toBeNull();
		expect(controller.getLastQueryError()).toContain('no snapshot');
	});

	it('rebuilds a client from a snapshot and answers queries', () => {
		const controller = new DevtoolsPanelController();
		expect(controller.setSnapshot(buildSnapshot())).toBe(true);
		expect(controller.hasSnapshot()).toBe(true);
		expect(controller.getFacts()).toHaveLength(5);
		expect(controller.getTransactions()).toHaveLength(5);

		expect(controller.runQuery(nameQuery)).toEqual([
			[1, 'Alice'],
			[2, 'Bob']
		]);
		expect(controller.getLastQueryRows()).toEqual([
			[1, 'Alice'],
			[2, 'Bob']
		]);
		expect(controller.getLastQueryError()).toBeNull();
	});

	it('rejects malformed snapshots and keeps the previous state', () => {
		const controller = new DevtoolsPanelController();
		const snapshot = buildSnapshot();
		controller.setSnapshot(snapshot);
		const before = controller.getFacts();

		const malformed = { facts: [{ nope: true }], transactions: [] } as unknown as FactSnapshot;
		expect(controller.setSnapshot(malformed)).toBe(false);
		expect(controller.getLastError()).toContain('not a valid FactSnapshot');
		expect(controller.getFacts()).toEqual(before);
		expect(controller.hasSnapshot()).toBe(true);
	});

	it('surfaces restore failures (ordering/tx-set violations)', () => {
		const controller = new DevtoolsPanelController();
		const orphanedFact: FactSnapshot = {
			facts: [[1, 'a', 'x', 1, 'add']],
			transactions: []
		};
		expect(controller.setSnapshot(orphanedFact)).toBe(false);
		expect(controller.getLastError()).toContain('snapshot rejected');
		expect(controller.hasSnapshot()).toBe(false);
	});

	it('normalizes wire-tagged values before replay', () => {
		const controller = new DevtoolsPanelController();
		const snapshot: FactSnapshot = {
			facts: [[1, 'born', { $date: 0 }, 1, 'add']],
			transactions: [[1, 1000, null]]
		};
		expect(controller.setSnapshot(snapshot)).toBe(true);
		const value = controller.getFacts()[0][2];
		expect(value).toBeInstanceOf(Date);
		expect((value as Date).getTime()).toBe(0);
	});

	it('computes diffs against the snapshot database', () => {
		const controller = new DevtoolsPanelController();
		controller.setSnapshot(buildSnapshot());

		const diff = controller.getDiff(2, 5);
		expect(diff?.added.map((fact) => fact[2])).toContain(31);
		expect(diff?.retracted.map((fact) => fact[2])).toContain(30);
		expect(controller.getLastDiff()).toEqual(diff);
	});

	it('records query errors instead of throwing', () => {
		const controller = new DevtoolsPanelController();
		controller.setSnapshot(buildSnapshot());

		const badSpec = { find: ['?e'], where: 'nope' } as unknown as QuerySpec;
		expect(controller.runQuery(badSpec)).toBeNull();
		expect(controller.getLastQueryError()).not.toBeNull();
		expect(controller.getLastQueryRows()).toBeNull();
	});

	it('notifies tab render callbacks on state transitions', () => {
		const controller = new DevtoolsPanelController();
		const factsCallback = vi.fn();
		const queryCallback = vi.fn();
		controller.setRenderCallback('facts', factsCallback);
		controller.setRenderCallback('query', queryCallback);

		controller.setSnapshot(buildSnapshot());
		expect(factsCallback).toHaveBeenCalledTimes(1);
		expect(queryCallback).toHaveBeenCalledTimes(1);

		controller.setActiveTab('query');
		expect(queryCallback).toHaveBeenCalledTimes(2);

		controller.runQuery(nameQuery);
		expect(queryCallback).toHaveBeenCalledTimes(3);
	});

	it('exports and imports snapshots as JSON text', () => {
		const controller = new DevtoolsPanelController();
		expect(() => controller.exportSnapshot()).toThrow(/no snapshot loaded/);

		controller.setSnapshot(buildSnapshot());
		const text = controller.exportSnapshot();

		const parsed = JSON.parse(text) as { facts: unknown[]; transactions: unknown[] };
		expect(Array.isArray(parsed.facts)).toBe(true);
		expect(Array.isArray(parsed.transactions)).toBe(true);

		const imported = new DevtoolsPanelController();
		const factsCallback = vi.fn();
		const queryCallback = vi.fn();
		imported.setRenderCallback('facts', factsCallback);
		imported.setRenderCallback('query', queryCallback);

		expect(imported.importSnapshot(text)).toBe(true);
		expect(imported.getFacts()).toEqual(controller.getFacts());
		expect(imported.getTransactions()).toEqual(controller.getTransactions());
		expect(imported.getLastError()).toBeNull();
		expect(factsCallback).toHaveBeenCalledTimes(1);
		expect(queryCallback).toHaveBeenCalledTimes(1);
	});

	it('importSnapshot rejects invalid text and keeps the previous state', () => {
		const controller = new DevtoolsPanelController();
		controller.setSnapshot(buildSnapshot());
		const before = controller.getFacts();

		expect(controller.importSnapshot('not json')).toBe(false);
		expect(controller.getLastError()).toContain('import rejected');

		const malformed = JSON.stringify({ facts: [{ nope: true }], transactions: [] });
		expect(controller.importSnapshot(malformed)).toBe(false);
		expect(controller.getLastError()).toContain('invalid snapshot');

		expect(controller.getFacts()).toEqual(before);
		expect(controller.hasSnapshot()).toBe(true);
	});

	it('imports a persistence-style versioned envelope', () => {
		const controller = new DevtoolsPanelController();
		const text = JSON.stringify({
			version: 1,
			facts: [[1, 'a', 'x', 1, 'add']],
			transactions: [[1, 100, null]]
		});

		expect(controller.importSnapshot(text)).toBe(true);
		expect(controller.getFacts()).toEqual([[1, 'a', 'x', 1, 'add']]);
	});

	describe('time travel', () => {
		it('rebuilds the client scoped to a transaction and back', () => {
			const controller = new DevtoolsPanelController();
			controller.setSnapshot(buildSnapshot());
			expect(controller.getTimeTravelTx()).toBeNull();
			expect(controller.getFacts()).toHaveLength(5);

			expect(controller.setTimeTravelTx(2)).toBe(true);
			expect(controller.getTimeTravelTx()).toBe(2);
			// Facts 3-5 (tx 3..5) are excluded: [2, 'user/name', 'Bob'] and the age retract/add.
			expect(controller.getFacts()).toEqual([
				[1, 'user/name', 'Alice', 1, 'add'],
				[1, 'user/age', 30, 2, 'add']
			]);
			expect(controller.getTransactions()).toHaveLength(2);

			// Queries run against the scoped client.
			expect(controller.runQuery(nameQuery)).toEqual([[1, 'Alice']]);

			// Back to the latest state.
			expect(controller.setTimeTravelTx(null)).toBe(true);
			expect(controller.getTimeTravelTx()).toBeNull();
			expect(controller.getFacts()).toHaveLength(5);
			expect(controller.runQuery(nameQuery)).toEqual([
				[1, 'Alice'],
				[2, 'Bob']
			]);
		});

		it('rejects invalid transactions and missing snapshots', () => {
			const controller = new DevtoolsPanelController();
			expect(controller.setTimeTravelTx(2)).toBe(false);
			expect(controller.getLastError()).toContain('no snapshot');

			controller.setSnapshot(buildSnapshot());
			expect(controller.setTimeTravelTx(0)).toBe(false);
			expect(controller.getLastError()).toContain('invalid time-travel tx');
		});

		it('rejects out-of-range pins and clamps above the last tx', () => {
			const controller = new DevtoolsPanelController();
			controller.setSnapshot(buildSnapshot());
			const before = controller.getFacts();

			// Below tx 1 is rejected; the previous state is kept.
			expect(controller.setTimeTravelTx(0)).toBe(false);
			expect(controller.getLastError()).toContain('invalid time-travel tx');
			expect(controller.getFacts()).toEqual(before);

			// Above the last tx clamps to the full log.
			controller.setTimeTravelTx(99);
			expect(controller.getFacts()).toHaveLength(5);
		});

		it('computes the step diff against the full log even while scoped', () => {
			const controller = new DevtoolsPanelController();
			controller.setSnapshot(buildSnapshot());
			controller.setTimeTravelTx(3);

			// tx 4 retracts age 30; the scoped client cannot see tx 4, but the
			// diff still reads the full snapshot db.
			const diff = controller.getTimeTravelDiff(4);
			expect(diff?.retracted.map((fact) => fact[2])).toContain(30);
			expect(controller.getLastTimeTravelDiff()).toEqual(diff);

			// The generic diff tab keeps working over the full log too.
			const range = controller.getDiff(2, 5);
			expect(range?.added.map((fact) => fact[2])).toContain(31);
			expect(range?.retracted.map((fact) => fact[2])).toContain(30);
		});

		it('resets time travel when a new snapshot arrives', () => {
			const controller = new DevtoolsPanelController();
			controller.setSnapshot(buildSnapshot());
			controller.setTimeTravelTx(2);
			expect(controller.getTimeTravelTx()).toBe(2);

			controller.setSnapshot(buildSnapshot());
			expect(controller.getTimeTravelTx()).toBeNull();
			expect(controller.getFacts()).toHaveLength(5);
		});
	});
});
