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
});
