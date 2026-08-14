/**
 * Unit tests: access-tracking live queries and async liveQuery streams (P2,
 * docs/design/03-reactivity-and-wire.md). Covers attribute-level relevance via
 * the AEVT index, memoization/diffing, dispose semantics, and AbortSignal.
 */

import { describe, expect, it, vi } from 'vitest';
import { createDatabase, type FactDatabase } from './index';

describe('db.live — access tracking', () => {
	it('passes the database as the first argument to the selector', () => {
		const db = createDatabase();
		db.add(1, 'user/role', 'admin');

		const fn = vi.fn((d: FactDatabase) => d.find({ 'user/role': 'admin' }).map((user) => user.id));
		const live = db.live(fn);
		expect(live.current).toEqual([1]);
		expect(fn).toHaveBeenCalledTimes(1);
		expect(fn).toHaveBeenCalledWith(db);

		// Re-evaluations on relevant writes receive the database too.
		db.add(2, 'user/role', 'admin');
		expect(fn).toHaveBeenCalledTimes(2);
		expect(fn).toHaveBeenLastCalledWith(db);
		expect(live.current).toEqual([1, 2]);

		live.dispose();
	});

	it('does not re-run fn when writes touch unrelated attributes', () => {
		const db = createDatabase();
		db.add(1, 'user/role', 'admin');
		db.add(2, 'user/role', 'viewer');
		db.add(1, 'user/name', 'Alice');
		db.add(2, 'user/name', 'Bob');

		const fn = vi.fn(() => db.find({ 'user/role': 'admin' }).map((user) => user.id));
		const live = db.live(fn);
		expect(live.current).toEqual([1]);
		expect(fn).toHaveBeenCalledTimes(1);

		// Unrelated attributes never re-run the selector.
		db.add(1, 'user/name', 'Alicia');
		db.add(2, 'user/age', 30);
		expect(fn).toHaveBeenCalledTimes(1);
		expect(live.current).toEqual([1]);

		// A related write re-runs once.
		db.add(2, 'user/role', 'admin');
		expect(fn).toHaveBeenCalledTimes(2);
		expect(live.current).toEqual([1, 2]);
	});

	it('records entity attribute reads through the Proxy', () => {
		const db = createDatabase();
		db.add(1, 'user/active', true);
		db.add(2, 'user/active', true);
		db.add(1, 'user/name', 'Alice');
		db.add(2, 'user/name', 'Bob');

		const fn = vi.fn(() => db.find({ 'user/active': true }).map((user) => user['user/name']));
		const live = db.live(fn);
		expect(live.current).toEqual(['Alice', 'Bob']);

		// 'user/age' was neither a criteria key nor a read attribute.
		db.add(1, 'user/age', 30);
		expect(fn).toHaveBeenCalledTimes(1);

		// 'user/name' was read on entity 1 -> re-run.
		db.add(1, 'user/name', 'Alicia');
		expect(fn).toHaveBeenCalledTimes(2);
		expect(live.current).toEqual(['Alicia', 'Bob']);
	});

	it('tracks reads through db.entity proxies', () => {
		const db = createDatabase();
		db.add(1, 'user/name', 'Alice');
		db.add(1, 'user/age', 30);

		const fn = vi.fn(() => {
			const entity = db.entity(1);
			return entity === null ? null : entity['user/name'];
		});
		const live = db.live(fn);
		expect(live.current).toBe('Alice');

		db.add(1, 'user/age', 31);
		expect(fn).toHaveBeenCalledTimes(1);

		db.add(1, 'user/name', 'Alicia');
		expect(fn).toHaveBeenCalledTimes(2);
		expect(live.current).toBe('Alicia');
	});

	it('re-runs when a brand-new entity gets a recorded attribute (AEVT candidate growth)', () => {
		const db = createDatabase();
		db.add(1, 'user/role', 'admin');
		const live = db.live({ 'user/role': 'admin' });
		expect(live.current).toHaveLength(1);

		// New pair on the recorded attribute is always relevant, even though the
		// entity was not a candidate at the last evaluation.
		db.add(2, 'user/role', 'viewer');
		expect(live.current).toHaveLength(1);

		db.add(3, 'user/role', 'admin');
		expect(live.current).toHaveLength(2);
	});
});

describe('db.live — explicit dependencies', () => {
	it('re-runs only on listed attributes (no Proxy)', () => {
		const db = createDatabase();
		db.add(1, 'user/role', 'admin');
		db.add(1, 'user/name', 'Alice');

		const fn = vi.fn(() => db.find({ 'user/role': 'admin' }));
		const live = db.live(['user/role'], fn);
		expect(live.current).toEqual([{ id: 1, 'user/role': 'admin', 'user/name': 'Alice' }]);

		db.add(1, 'user/name', 'Alicia');
		expect(fn).toHaveBeenCalledTimes(1);

		db.add(2, 'user/role', 'admin');
		expect(fn).toHaveBeenCalledTimes(2);
		expect(live.current).toHaveLength(2);
	});
});

describe('db.live — criteria and QuerySpec forms', () => {
	it('accepts a criteria object directly', () => {
		const db = createDatabase();
		db.add(1, 'user/role', 'admin');
		db.add(2, 'user/role', 'viewer');

		const live = db.live({ 'user/role': 'admin' });
		expect(live.current).toEqual([{ id: 1, 'user/role': 'admin' }]);

		const callback = vi.fn();
		live.subscribe(callback);

		db.add(1, 'user/name', 'Alice');
		expect(callback).not.toHaveBeenCalled();

		db.add(2, 'user/role', 'admin');
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it('accepts a QuerySpec directly', () => {
		const db = createDatabase();
		db.add(1, 'user/role', 'admin');
		db.add(2, 'user/role', 'admin');

		const live = db.live({ find: ['?e'], where: [['?e', 'user/role', 'admin']] });
		expect(live.current).toEqual([[1], [2]]);

		const callback = vi.fn();
		live.subscribe(callback);

		db.add(1, 'user/name', 'Alice');
		expect(callback).not.toHaveBeenCalled();

		db.add(3, 'user/role', 'admin');
		expect(callback).toHaveBeenCalledTimes(1);
		expect(live.current).toEqual([[1], [2], [3]]);
	});
});
describe('db.live — notification, memoization, diffing', () => {
	it('notifies subscribers once per related transaction', () => {
		const db = createDatabase();
		const live = db.live({ 'user/role': 'admin' });
		const callback = vi.fn();
		live.subscribe(callback);

		db.transact([
			['add', 1, 'user/role', 'admin'],
			['add', 1, 'user/name', 'Alice']
		]);
		expect(callback).toHaveBeenCalledTimes(1);

		db.transact([
			['add', 2, 'user/role', 'admin'],
			['add', 2, 'user/role', 'admin']
		]);
		expect(callback).toHaveBeenCalledTimes(2);
	});

	it('memoizes the result — same object identity when nothing changed', () => {
		const db = createDatabase();
		db.add(1, 'user/role', 'admin');
		db.add(2, 'user/role', 'viewer');

		const live = db.live({ 'user/role': 'admin' });
		const first = live.current;
		expect(first).toEqual([{ id: 1, 'user/role': 'admin' }]);

		// Unrelated write: no re-evaluation at all, identity trivially kept.
		db.add(2, 'user/name', 'Bob');
		expect(live.current).toBe(first);

		// Related write that does not change the result: re-evaluated, diffed,
		// and the previous memoized object is kept.
		db.add(3, 'user/role', 'viewer');
		expect(live.current).toBe(first);

		// A real change produces a fresh object.
		db.add(2, 'user/role', 'admin');
		expect(live.current).not.toBe(first);
		expect(live.current).toHaveLength(2);
	});

	it('notifies only on actual change (result diffing)', () => {
		const db = createDatabase();
		db.add(1, 'user/role', 'admin');
		const live = db.live({ 'user/role': 'admin' });
		const callback = vi.fn();
		live.subscribe(callback);

		// Related write, same value: the result did not change.
		db.add(1, 'user/role', 'admin');
		expect(callback).not.toHaveBeenCalled();

		db.add(2, 'user/role', 'admin');
		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenLastCalledWith([
			{ id: 1, 'user/role': 'admin' },
			{ id: 2, 'user/role': 'admin' }
		]);
	});

	it('subscribe returns an unsubscribe function', () => {
		const db = createDatabase();
		db.add(1, 'user/role', 'admin');
		const live = db.live({ 'user/role': 'admin' });
		const callback = vi.fn();
		const unsubscribe = live.subscribe(callback);

		db.add(2, 'user/role', 'admin');
		expect(callback).toHaveBeenCalledTimes(1);

		unsubscribe();
		db.add(3, 'user/role', 'admin');
		expect(callback).toHaveBeenCalledTimes(1);
	});
});

describe('db.live — dispose semantics', () => {
	it('stops tracking and keeps current read-safe after dispose', () => {
		const db = createDatabase();
		db.add(1, 'user/role', 'admin');
		const live = db.live({ 'user/role': 'admin' });
		const callback = vi.fn();
		live.subscribe(callback);

		const snapshot = live.current;
		live.dispose();

		db.add(2, 'user/role', 'admin');
		expect(callback).not.toHaveBeenCalled();
		expect(live.current).toBe(snapshot);

		// Dispose is idempotent and further subscriptions are inert.
		live.dispose();

		const late = vi.fn();
		live.subscribe(late);
		db.add(3, 'user/role', 'admin');
		expect(late).not.toHaveBeenCalled();
	});
});

describe('db.liveQuery', () => {
	it('yields the initial result then each subsequent change', async () => {
		const db = createDatabase();
		db.add(1, 'user/role', 'admin');

		const query = db.liveQuery({ 'user/role': 'admin' });
		const iterator = query[Symbol.asyncIterator]();

		const first = await iterator.next();
		expect(first.done).toBe(false);
		expect(first.value).toEqual([{ id: 1, 'user/role': 'admin' }]);

		db.add(2, 'user/role', 'admin');
		const second = await iterator.next();
		expect(second.done).toBe(false);
		expect(second.value).toEqual([
			{ id: 1, 'user/role': 'admin' },
			{ id: 2, 'user/role': 'admin' }
		]);

		// Unrelated writes are not delivered: the stream stays pending and the
		// result is unchanged (result diffing suppresses the notification).
		db.add(1, 'user/name', 'Alice');
		db.add(2, 'user/age', 30);
		await expect(
			Promise.race([iterator.next(), Promise.resolve('no-delivery')])
		).resolves.toBe('no-delivery');
		expect(query.current).toEqual([
			{ id: 1, 'user/role': 'admin' },
			{ id: 2, 'user/role': 'admin' }
		]);

		query.dispose();
		const after = await iterator.next();
		expect(after.done).toBe(true);
	});

	it('iterator.return() settles while the stream is idle-pending (no hang)', async () => {
		const db = createDatabase();
		db.add(1, 'user/role', 'admin');

		const query = db.liveQuery({ 'user/role': 'admin' });
		const iterator = query[Symbol.asyncIterator]();

		const first = await iterator.next();
		expect(first.done).toBe(false);
		expect(first.value).toEqual([{ id: 1, 'user/role': 'admin' }]);

		// Leave a next() unanswered: the generator suspends on its internal
		// idle await. A return() issued now used to hang until the next
		// notification or dispose(); it must settle instead.
		const pendingNext = iterator.next();
		const settled = await Promise.race([
			iterator.return().then(() => 'returned' as const),
			new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1000))
		]);
		expect(settled).toBe('returned');

		// The generator's finally disposed the handle: the abandoned next()
		// and any later reads complete as done.
		expect((await pendingNext).done).toBe(true);
		expect((await iterator.next()).done).toBe(true);
		expect(query.current).toEqual([{ id: 1, 'user/role': 'admin' }]);

		query.dispose();
	});

	it('works with for-await and disposes via query.dispose()', async () => {
		const db = createDatabase();
		db.add(1, 'user/role', 'admin');

		const query = db.liveQuery({ 'user/role': 'admin' });
		const values: Array<Array<{ id: number; 'user/role': string }>> = [];
		const pump = (async () => {
			for await (const rows of query) {
				values.push(rows);
			}
		})();

		// An async generator takes two microtask turns to deliver the first
		// yielded value; a macrotask flush is deterministic either way.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(values).toEqual([[{ id: 1, 'user/role': 'admin' }]]);

		db.add(2, 'user/role', 'admin');
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(values).toEqual([
			[{ id: 1, 'user/role': 'admin' }],
			[
				{ id: 1, 'user/role': 'admin' },
				{ id: 2, 'user/role': 'admin' }
			]
		]);

		query.dispose();
		await pump;
		expect(values).toHaveLength(2);
	});

	it('stops delivery when the AbortSignal fires', async () => {
		const db = createDatabase();
		db.add(1, 'user/role', 'admin');
		const controller = new AbortController();
		const query = db.liveQuery({ 'user/role': 'admin' }, { signal: controller.signal });
		const iterator = query[Symbol.asyncIterator]();

		const first = await iterator.next();
		expect(first.value).toEqual([{ id: 1, 'user/role': 'admin' }]);

		db.add(2, 'user/role', 'admin');
		controller.abort();

		const after = await iterator.next();
		expect(after.done).toBe(true);
	});

	it('delivers nothing when the signal is already aborted', async () => {
		const db = createDatabase();
		const controller = new AbortController();
		controller.abort();
		const query = db.liveQuery({ 'user/role': 'admin' }, { signal: controller.signal });
		const iterator = query[Symbol.asyncIterator]();
		const result = await iterator.next();
		expect(result.done).toBe(true);
	});

	it('also exposes current/subscribe/dispose', () => {
		const db = createDatabase();
		db.add(1, 'user/role', 'admin');
		const query = db.liveQuery({ 'user/role': 'admin' });
		expect(query.current).toEqual([{ id: 1, 'user/role': 'admin' }]);

		const callback = vi.fn();
		query.subscribe(callback);
		db.add(2, 'user/role', 'admin');
		expect(callback).toHaveBeenCalledTimes(1);
		expect(query.current).toHaveLength(2);

		query.dispose();
		db.add(3, 'user/role', 'admin');
		expect(callback).toHaveBeenCalledTimes(1);
		expect(query.current).toHaveLength(2);
	});
});

