/**
 * React integration tests
 */

import { describe, it, expect } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { act, create as createTestRenderer, type ReactTestRenderer } from 'react-test-renderer';
import {
	FatosProvider,
	createClient,
	useDatalogQuery,
	useEntity,
	useFatosClient,
	useQuery,
	useTransaction,
	version
} from './index';
import type { EntityState, QueryTerm, TransactionRecord } from './index';

// react-test-renderer drives hooks without a DOM (no jsdom); opt into act().
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(element: ReactElement): ReactTestRenderer {
	let renderer: ReactTestRenderer = null as never;
	act(() => {
		renderer = createTestRenderer(element);
	});
	return renderer;
}

describe('@fatos/react', () => {
	it('should export version', () => {
		expect(version).toBeDefined();
	});

	it('exports phase 2 react integration primitives', () => {
		expect(typeof createClient).toBe('function');
		expect(typeof FatosProvider).toBe('function');
		expect(typeof useFatosClient).toBe('function');
		expect(typeof useQuery).toBe('function');
		expect(typeof useDatalogQuery).toBe('function');
		expect(typeof useEntity).toBe('function');
		expect(typeof useTransaction).toBe('function');
	});

	it('throws when data hooks are used outside FatosProvider', () => {
		function Probe() {
			useQuery({ 'user/role': 'admin' });
			return null;
		}

		expect(() => createTestRenderer(createElement(Probe))).toThrow(
			'useFatosClient must be used within FatosProvider'
		);
	});

	it('useQuery(selector) keeps snapshot identity across unrelated writes and updates on relevant ones', () => {
		const client = createClient();
		client.add(1, 'user/role', 'admin');
		client.add(1, 'user/name', 'Alice');

		const snapshots: EntityState[][] = [];
		let renderCount = 0;
		function Probe() {
			renderCount += 1;
			const admins = useQuery((db) => db.find({ 'user/role': 'admin' }));
			snapshots.push(admins);
			return createElement('div', null, String(admins.length));
		}

		render(createElement(FatosProvider, { client }, createElement(Probe)));
		expect(renderCount).toBe(1);
		expect(snapshots).toHaveLength(1);
		const initial = snapshots[0];

		// Unrelated write: useSyncExternalStore bails out, identical snapshot.
		act(() => {
			client.add(1, 'user/age', 30);
		});
		expect(renderCount).toBe(1);
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]).toBe(initial);

		// Relevant write: re-render with a fresh snapshot.
		act(() => {
			client.add(2, 'user/role', 'admin');
		});
		expect(renderCount).toBe(2);
		expect(snapshots).toHaveLength(2);
		expect(snapshots[1]).not.toBe(initial);
		expect(snapshots[1]).toEqual([
			{ id: 1, 'user/role': 'admin', 'user/name': 'Alice', 'user/age': 30 },
			{ id: 2, 'user/role': 'admin' }
		]);

		// The updated snapshot stays stable across further unrelated writes.
		const updated = snapshots[1];
		act(() => {
			client.add(2, 'user/name', 'Bob');
		});
		expect(renderCount).toBe(2);
		expect(snapshots[1]).toBe(updated);
	});

	it('useQuery(criteria) keeps snapshot identity across unrelated writes', () => {
		const client = createClient();
		client.add(1, 'user/role', 'admin');
		client.add(1, 'user/name', 'Alice');

		const snapshots: EntityState[][] = [];
		let renderCount = 0;
		function Probe() {
			renderCount += 1;
			// A fresh criteria object per render maps to the same query key,
			// so the memoized snapshot is reused.
			const admins = useQuery({ 'user/role': 'admin' });
			snapshots.push(admins);
			return createElement('div', null, String(admins.length));
		}

		render(createElement(FatosProvider, { client }, createElement(Probe)));
		expect(renderCount).toBe(1);
		expect(snapshots).toHaveLength(1);
		const initial = snapshots[0];

		// Unrelated attribute: no re-render, identical snapshot.
		act(() => {
			client.add(1, 'user/age', 30);
		});
		expect(renderCount).toBe(1);
		expect(snapshots[0]).toBe(initial);

		// Relevant write: fresh snapshot with the new match.
		act(() => {
			client.add(2, 'user/role', 'admin');
		});
		expect(renderCount).toBe(2);
		expect(snapshots[1]).not.toBe(initial);
		expect(snapshots[1]).toEqual([
			{ id: 1, 'user/role': 'admin', 'user/name': 'Alice', 'user/age': 30 },
			{ id: 2, 'user/role': 'admin' }
		]);
	});

	it('useDatalogQuery memoizes rows across unrelated writes', () => {
		const client = createClient();
		client.add(1, 'user/role', 'admin');
		client.add(1, 'user/name', 'Alice');

		const snapshots: QueryTerm[][][] = [];
		let renderCount = 0;
		function Probe() {
			renderCount += 1;
			const rows = useDatalogQuery({ find: ['?e'], where: [['?e', 'user/role', 'admin']] });
			snapshots.push(rows);
			return createElement('div', null, String(rows.length));
		}

		render(createElement(FatosProvider, { client }, createElement(Probe)));
		expect(renderCount).toBe(1);
		expect(snapshots[0]).toEqual([[1]]);
		const initial = snapshots[0];

		act(() => {
			client.add(1, 'user/age', 30); // unrelated attribute
		});
		expect(renderCount).toBe(1);
		expect(snapshots[0]).toBe(initial);

		act(() => {
			client.add(2, 'user/role', 'admin'); // relevant write
		});
		expect(renderCount).toBe(2);
		expect(snapshots[1]).toEqual([[1], [2]]);
	});

	it('useEntity memoizes the entity snapshot across unrelated writes', () => {
		const client = createClient();
		client.add(1, 'user/name', 'Alice');
		client.add(2, 'user/name', 'Bob');

		const snapshots: (EntityState | null)[] = [];
		let renderCount = 0;
		function Probe() {
			renderCount += 1;
			const entity = useEntity(1);
			snapshots.push(entity);
			return createElement('div', null, String(entity?.id ?? 'none'));
		}

		render(createElement(FatosProvider, { client }, createElement(Probe)));
		expect(renderCount).toBe(1);
		expect(snapshots[0]).toEqual({ id: 1, 'user/name': 'Alice' });
		const initial = snapshots[0];

		// A write to a different entity re-evaluates the live handle but the
		// memoized snapshot is unchanged, so React bails out.
		act(() => {
			client.add(2, 'user/age', 30);
		});
		expect(renderCount).toBe(1);
		expect(snapshots[0]).toBe(initial);

		// A write to the watched entity produces a fresh snapshot.
		act(() => {
			client.add(1, 'user/age', 30);
		});
		expect(renderCount).toBe(2);
		expect(snapshots[1]).not.toBe(initial);
		expect(snapshots[1]).toEqual({ id: 1, 'user/name': 'Alice', 'user/age': 30 });
	});

	it('useTransaction returns the memoized transaction history', () => {
		const client = createClient();
		client.add(1, 'user/name', 'Alice'); // transaction 1

		const snapshots: readonly (readonly TransactionRecord[])[] = [];
		let renderCount = 0;
		function Probe() {
			renderCount += 1;
			const transactions = useTransaction();
			snapshots.push(transactions);
			return createElement('div', null, String(transactions.length));
		}

		render(createElement(FatosProvider, { client }, createElement(Probe)));
		expect(renderCount).toBe(1);
		expect(snapshots[0]).toHaveLength(1);
		const initial = snapshots[0];

		act(() => {
			client.add(1, 'user/age', 30); // transaction 2
		});
		expect(renderCount).toBe(2);
		expect(snapshots[1]).not.toBe(initial);
		expect(snapshots[1]).toHaveLength(2);

		// Prior records keep their identity inside the new snapshot.
		expect(snapshots[1]?.[0]).toBe(initial[0]);
	});
});

