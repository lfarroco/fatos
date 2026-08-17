/**
 * Browser client tests
 */

import { describe, it, expect, vi } from 'vitest';
import { isRef, ref, REF_BRAND, type Ref } from '@fatos/core';
import {
	createClient,
	version,
	FactEvent,
	TransactionEvent,
	FACT_ADDED_EVENT,
	FACT_RETRACTED_EVENT,
	TRANSACTION_COMMITTED_EVENT,
	type EntityState,
	type Fact,
	type FatosClient,
	type FindOptions,
	type QueryTerm,
	type TransactionRecord
} from './index';

describe('@fatos/client', () => {
	it('should export version', () => {
		expect(version).toBeDefined();
	});

	it('provides browser-friendly core APIs', () => {
		const client = createClient();

		client.transact([
			['add', 1, 'type', 'user'],
			['add', 1, 'name', 'Alice'],
			['add', 2, 'type', 'user']
		]);

		expect(client.find({ type: 'user' })).toEqual([
			{ id: 1, type: 'user', name: 'Alice' },
			{ id: 2, type: 'user' }
		]);
		expect(
			client.query({
				find: ['?e'],
				where: [['?e', 'type', 'user']]
			})
		).toEqual([[1], [2]]);
	});

	it('supports ergonomic tuple add and tuple transact', () => {
		const client = createClient();

		client.add(['eid1', 'name', 'Alice']);
		client.add(['eid1', 'name', 'Alicia']);
		client.transact([
			['eid1', 'type', 'user'],
			['eid2', 'name', 'Bob']
		]);

		expect(client.entity('eid1')).toEqual({ id: 'eid1', name: 'Alicia', type: 'user' });
		expect(client.entity('eid2')).toEqual({ id: 'eid2', name: 'Bob' });
	});

	it('observes query criteria changes reactively', () => {
		const client = createClient();
		const snapshots: Array<Array<{ id: number; type: string }>> = [];

		const unsubscribe = client.observe({ type: 'user' }, (entities) => {
			snapshots.push(entities as Array<{ id: number; type: string }>);
		});

		client.add(1, 'type', 'user');
		client.add(2, 'type', 'admin');
		client.add(3, 'type', 'user');
		unsubscribe();
		client.add(4, 'type', 'user');

		expect(snapshots).toEqual([
			[],
			[{ id: 1, type: 'user' }],
			[
				{ id: 1, type: 'user' },
				{ id: 3, type: 'user' }
			]
		]);
	});

	it('supports transaction-scoped reads through atTransaction', () => {
		const client = createClient();
		client.add(7, 'name', 'Alice');
		client.add(7, 'type', 'user');
		client.retract(7, 'type', 'user');

		const at2 = client.atTransaction(2);
		const at3 = client.atTransaction(3);

		expect(at2.entity(7)).toEqual({ id: 7, name: 'Alice', type: 'user' });
		expect(at3.entity(7)).toEqual({ id: 7, name: 'Alice' });
	});

	it('find supports orderBy / limit / offset / select options (G1)', () => {
		const client = createClient();
		client.transact([
			['add', 1, 'card/column', 'todo'],
			['add', 1, 'card/order', 3],
			['add', 2, 'card/column', 'todo'],
			['add', 2, 'card/order', 1],
			['add', 3, 'card/column', 'todo'],
			['add', 3, 'card/order', 2]
		]);

		const ordered = client.find({ 'card/column': 'todo' }, { orderBy: ['card/order', 'asc'] });
		expect(ordered.map((entity) => entity.id)).toEqual([2, 3, 1]);

		const page = client.find(
			{ 'card/column': 'todo' },
			{ orderBy: ['card/order', 'asc'], offset: 1, limit: 1 }
		);
		expect(page.map((entity) => entity.id)).toEqual([3]);

		const picked = client.find({ 'card/column': 'todo' }, { select: ['card/order'] });
		expect(picked).toEqual([
			{ id: 1, 'card/order': 3 },
			{ id: 2, 'card/order': 1 },
			{ id: 3, 'card/order': 2 }
		]);

		// The positional tx form keeps working alongside the options form.
		expect(client.find({ 'card/column': 'todo' }, 1).map((entity) => entity.id)).toEqual([1, 2, 3]);

		// FindOptions is re-exported for consumers to name the options type.
		const options: FindOptions = { orderBy: ['card/order', 'desc'] };
		expect(client.find({ 'card/column': 'todo' }, options).map((entity) => entity.id)).toEqual([1, 3, 2]);
	});

	it('atTransaction(tx).find accepts options while keeping the tx scope (G1)', () => {
		const client = createClient();
		client.transact([
			['add', 1, 'card/column', 'todo'],
			['add', 1, 'card/order', 3]
		]);
		client.transact([
			['add', 2, 'card/column', 'todo'],
			['add', 2, 'card/order', 1]
		]);
		client.transact([
			['retract', 2, 'card/order', 1],
			['add', 2, 'card/order', 5]
		]); // tx 3 — reorders card 2 only

		const at2 = client.atTransaction(2);
		expect(at2.find({ 'card/column': 'todo' }, { orderBy: ['card/order', 'asc'] }).map((e) => e.id)).toEqual([
			2, 1
		]);
		expect(client.find({ 'card/column': 'todo' }, { orderBy: ['card/order', 'asc'] }).map((e) => e.id)).toEqual([
			1, 2
		]);
	});

	it('entity/find/atTransaction surface the refs read option', () => {
		const client = createClient();
		client.add(1, 'friend', ref(42));
		client.add(1, 'name', 'Alice');
		client.add(2, 'name', 'Bob');
		client.add(2, 'friend', ref(1));

		// default: plain ids
		expect(client.entity(2)).toEqual({ id: 2, name: 'Bob', friend: 1 });
		expect(client.find({ friend: ref(1) })).toEqual([{ id: 2, name: 'Bob', friend: 1 }]);

		// { refs: 'ref' }: branded ref values
		const branded = client.entity(2, undefined, { refs: 'ref' }) as { id: number; friend: Ref };
		expect(isRef(branded.friend)).toBe(true);
		expect(branded.friend[REF_BRAND]).toBe(1);

		// through the time-travel view (entity 2 lands at tx 4)
		expect(client.atTransaction(4).entity(2)).toEqual({ id: 2, name: 'Bob', friend: 1 });
		expect(client.atTransaction(4).entity(2, { refs: 'ref' })).toEqual({ id: 2, name: 'Bob', friend: ref(1) });
		expect(client.atTransaction(4).find({ friend: ref(1) }, { refs: 'ref' })).toEqual([
			{ id: 2, name: 'Bob', friend: ref(1) }
		]);
	});
});

describe('@fatos/client — EventTarget reactivity (P2)', () => {
	it('dispatches fact:added and transaction:committed on add', () => {
		const client = createClient();
		const added: Fact[] = [];
		const committed: TransactionEvent[] = [];
		client.addEventListener(FACT_ADDED_EVENT, (event) => added.push((event as FactEvent).fact));
		client.addEventListener(TRANSACTION_COMMITTED_EVENT, (event) => committed.push(event as TransactionEvent));

		const fact = client.add(1, 'name', 'Alice');

		expect(added).toEqual([fact]);
		expect(committed).toHaveLength(1);
		expect(committed[0]).toBeInstanceOf(TransactionEvent);
		expect(committed[0].type).toBe(TRANSACTION_COMMITTED_EVENT);
		expect(committed[0].transaction[0]).toBe(fact[3]);
		expect(committed[0].facts).toEqual([fact]);
		expect(committed[0].detail).toEqual({ transaction: committed[0].transaction, facts: [fact] });
	});

	it('dispatches fact:retracted and transaction:committed on retract', () => {
		const client = createClient();
		const events: FactEvent[] = [];
		const committed: TransactionEvent[] = [];
		client.addEventListener(FACT_RETRACTED_EVENT, (event) => events.push(event as FactEvent));
		client.addEventListener(TRANSACTION_COMMITTED_EVENT, (event) => committed.push(event as TransactionEvent));

		const fact = client.retract(1, 'name', 'Alice');

		expect(fact[4]).toBe('retract');
		expect(events).toHaveLength(1);
		expect(events[0]).toBeInstanceOf(FactEvent);
		expect(events[0].type).toBe(FACT_RETRACTED_EVENT);
		expect(events[0].fact).toEqual(fact);
		expect(events[0].detail).toEqual({ fact });
		expect(committed).toHaveLength(1);
		expect(committed[0].facts).toEqual([fact]);
	});

	it('transact dispatches per-fact events then one transaction:committed', () => {
		const client = createClient();
		const added: string[] = [];
		const retracted: string[] = [];
		const committed: TransactionEvent[] = [];
		client.addEventListener(FACT_ADDED_EVENT, (event) => added.push((event as FactEvent).fact[2] as string));
		client.addEventListener(FACT_RETRACTED_EVENT, (event) => retracted.push((event as FactEvent).fact[2] as string));
		client.addEventListener(TRANSACTION_COMMITTED_EVENT, (event) => committed.push(event as TransactionEvent));

		const facts = client.transact([
			['add', 1, 'name', 'Alice'],
			['retract', 1, 'name', 'Alice'],
			['add', 1, 'type', 'user']
		]);

		expect(added).toEqual(['Alice', 'user']);
		expect(retracted).toEqual(['Alice']);
		expect(committed).toHaveLength(1);
		expect(committed[0].transaction[0]).toBe(facts[0][3]);
		expect(committed[0].facts).toEqual(facts);
	});

	it('does not dispatch when a transaction commits no facts', () => {
		const client = createClient();
		let committed = 0;
		client.addEventListener(TRANSACTION_COMMITTED_EVENT, () => {
			committed += 1;
		});

		client.transact([]);
		expect(committed).toBe(0);
	});

	it('subscribe() remains sugar over transaction:committed', () => {
		const client = createClient();
		let calls = 0;
		const unsubscribe = client.subscribe(() => {
			calls += 1;
		});

		client.add(1, 'name', 'Alice');
		client.retract(1, 'name', 'Alice');
		client.transact([['add', 1, 'type', 'user']]);
		unsubscribe();
		client.add(1, 'active', true);

		expect(calls).toBe(3);
	});

	it('supports EventTarget methods directly (add/remove/once)', () => {
		const client = createClient();
		const seen: string[] = [];
		const handler = (event: Event): void => {
			seen.push(event.type);
		};
		const onceHandler = (event: Event): void => {
			seen.push(`once:${event.type}`);
		};
		client.addEventListener(FACT_ADDED_EVENT, handler);
		client.addEventListener(FACT_ADDED_EVENT, onceHandler, { once: true });
		client.add(1, 'a', 1);
		client.removeEventListener(FACT_ADDED_EVENT, handler);
		client.add(1, 'b', 2);
		client.add(1, 'c', 3);

		expect(seen).toEqual([FACT_ADDED_EVENT, `once:${FACT_ADDED_EVENT}`]);
	});

	it('observeQuery / observeEntity / observeTransactions keep working', () => {
		const client = createClient();
		const rows: QueryTerm[][][] = [];
		const entities: Array<EntityState | null> = [];
		const transactions: Array<readonly TransactionRecord[]> = [];

		client.observeQuery({ find: ['?e'], where: [['?e', 'type', 'user']] }, (r) => rows.push(r));
		client.observeEntity(1, (e) => entities.push(e));
		client.observeTransactions((t) => transactions.push(t));

		client.transact([
			['add', 1, 'type', 'user'],
			['add', 1, 'name', 'Alice']
		]);
		client.add(2, 'type', 'user');
		client.add(2, 'name', 'Bob');

		expect(rows[rows.length - 1]).toEqual([[1], [2]]);
		expect(entities[entities.length - 1]).toEqual({ id: 1, type: 'user', name: 'Alice' });
		expect(transactions).toHaveLength(4);
		expect(transactions[transactions.length - 1]).toHaveLength(3);
	});
});

describe('@fatos/client — live queries (P2)', () => {
	it('passes the client as the first argument to the live() selector', () => {
		const client = createClient();
		client.add(1, 'type', 'user');

		const fn = vi.fn((c: FatosClient) => c.find({ type: 'user' }).map((user) => user.id));
		const live = client.live(fn);
		expect(live.current).toEqual([1]);
		expect(fn).toHaveBeenCalledTimes(1);
		expect(fn).toHaveBeenCalledWith(client);

		// Re-evaluations on relevant writes receive the client too.
		client.add(2, 'type', 'user');
		expect(fn).toHaveBeenCalledTimes(2);
		expect(fn).toHaveBeenLastCalledWith(client);
		expect(live.current).toEqual([1, 2]);

		live.dispose();
	});

	it('delegates live() criteria form to the core database', () => {
		const client = createClient();
		const live = client.live({ type: 'user' });
		expect(live.current).toEqual([]);

		client.add(1, 'type', 'user');
		expect(live.current).toEqual([{ id: 1, type: 'user' }]);

		const changes: EntityState[][] = [];
		const unsubscribe = live.subscribe((value) => changes.push(value));
		client.add(2, 'type', 'user');
		expect(changes).toEqual([
			[
				{ id: 1, type: 'user' },
				{ id: 2, type: 'user' }
			]
		]);

		unsubscribe();
		client.add(3, 'type', 'user');
		expect(changes).toHaveLength(1);

		live.dispose();
		client.add(4, 'type', 'user');
		expect(live.current).toHaveLength(3);
	});

	it('live() selector form only re-runs on relevant writes', () => {
		const client = createClient();
		client.add(1, 'type', 'user');
		client.add(1, 'name', 'Alice');

		let runs = 0;
		const live = client.live(() => {
			runs += 1;
			return client.find({ type: 'user' }).map((user) => user.id);
		});
		expect(live.current).toEqual([1]);
		expect(runs).toBe(1);

		client.add(1, 'age', 30);
		expect(runs).toBe(1);

		client.add(2, 'type', 'user');
		expect(runs).toBe(2);
		expect(live.current).toEqual([1, 2]);
		live.dispose();
	});

	it('delegates live() explicit-dependency and QuerySpec forms', () => {
		const client = createClient();
		client.add(1, 'user/role', 'admin');
		client.add(1, 'user/name', 'Alice');

		const deps = client.live(['user/role'], () => client.find({ 'user/role': 'admin' }));
		expect(deps.current).toEqual([{ id: 1, 'user/role': 'admin', 'user/name': 'Alice' }]);
		// Unrelated attribute: the explicit-deps form does not re-run.
		client.add(1, 'user/name', 'Alicia');
		expect(deps.current).toEqual([{ id: 1, 'user/role': 'admin', 'user/name': 'Alice' }]);
		// Relevant write: re-runs and reads the fresh state.
		client.add(2, 'user/role', 'admin');
		expect(deps.current).toEqual([
			{ id: 1, 'user/role': 'admin', 'user/name': 'Alicia' },
			{ id: 2, 'user/role': 'admin' }
		]);
		deps.dispose();

		const spec = client.live({ find: ['?e'], where: [['?e', 'user/role', 'admin']] });
		expect(spec.current).toEqual([[1], [2]]);
		client.add(3, 'user/role', 'admin');
		expect(spec.current).toEqual([[1], [2], [3]]);
		spec.dispose();
	});

	it('live() requires a selector for the deps form', () => {
		const client = createClient();
		expect(() => client.live(['user/role'])).toThrow('live(deps, fn) requires a selector function');
	});

	it('delegates liveQuery() async iteration to the core database', async () => {
		const client = createClient();
		const query = client.liveQuery({ 'user/role': 'admin' });
		const iterator = query[Symbol.asyncIterator]();

		const first = await iterator.next();
		expect(first.done).toBe(false);
		expect(first.value).toEqual([]);

		client.add(1, 'user/role', 'admin');
		const second = await iterator.next();
		expect(second.done).toBe(false);
		expect(second.value).toEqual([{ id: 1, 'user/role': 'admin' }]);

		// dispose() via the iterator's return() stops delivery.
		await iterator.return();
		client.add(2, 'user/role', 'admin');
		const after = await iterator.next();
		expect(after.done).toBe(true);
	});

	it('liveQuery() stops delivery when the AbortSignal fires', async () => {
		const client = createClient();
		const controller = new AbortController();
		const query = client.liveQuery({ 'user/role': 'admin' }, { signal: controller.signal });
		const iterator = query[Symbol.asyncIterator]();

		const first = await iterator.next();
		expect(first.done).toBe(false);
		expect(first.value).toEqual([]);

		client.add(1, 'user/role', 'admin');
		controller.abort();
		const after = await iterator.next();
		expect(after.done).toBe(true);
	});
});

describe('@fatos/client — observe* fine-grained reactivity (B4.4)', () => {
	it('observe() fires synchronously with the initial result and only on relevant changes', () => {
		const client = createClient();
		const callback = vi.fn();
		client.add(1, 'type', 'user');
		const unsubscribe = client.observe({ type: 'user' }, callback);
		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenLastCalledWith([{ id: 1, type: 'user' }]);

		callback.mockClear();
		// Unrelated: a write to a different attribute is pruned entirely.
		client.add(2, 'name', 'Bob');
		expect(callback).not.toHaveBeenCalled();
		// Unrelated: a write to the recorded attribute that does not change
		// the result (new entity, non-matching value) is diffed away.
		client.add(2, 'type', 'admin');
		expect(callback).not.toHaveBeenCalled();
		// Unrelated: a matching entity gaining an unrelated attribute stays pruned.
		client.add(1, 'name', 'Alice');
		expect(callback).not.toHaveBeenCalled();

		// Relevant: a new entity matches the criteria (fresh full snapshot,
		// including the pruned-but-now-present attribute).
		client.add(3, 'type', 'user');
		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenLastCalledWith([
			{ id: 1, type: 'user', name: 'Alice' },
			{ id: 3, type: 'user' }
		]);

		unsubscribe();
		client.add(4, 'type', 'user');
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it('observeQuery() fires synchronously with the initial rows and only on relevant changes', () => {
		const client = createClient();
		const callback = vi.fn();
		client.add(1, 'user/role', 'admin');
		const unsubscribe = client.observeQuery(
			{ find: ['?e'], where: [['?e', 'user/role', 'admin']] },
			callback
		);
		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenLastCalledWith([[1]]);

		callback.mockClear();
		// Unrelated: a write to an attribute outside the where clause.
		client.add(1, 'user/name', 'Alice');
		expect(callback).not.toHaveBeenCalled();
		// Unrelated: a write to the queried attribute that does not change the rows.
		client.add(2, 'user/role', 'viewer');
		expect(callback).not.toHaveBeenCalled();

		// Relevant: a new entity matches the query.
		client.add(3, 'user/role', 'admin');
		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenLastCalledWith([[1], [3]]);

		unsubscribe();
		client.add(4, 'user/role', 'admin');
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it('observeEntity() fires synchronously with the entity and only when it actually changes', () => {
		const client = createClient();
		const callback = vi.fn();
		client.add(1, 'name', 'Alice');
		const unsubscribe = client.observeEntity(1, callback);
		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenLastCalledWith({ id: 1, name: 'Alice' });

		callback.mockClear();
		// Unrelated: writes on other entities never wake the observer.
		client.add(2, 'name', 'Bob');
		client.add(2, 'age', 30);
		expect(callback).not.toHaveBeenCalled();
		// Unrelated: a no-op re-add of the same value is diffed away.
		client.add(1, 'name', 'Alice');
		expect(callback).not.toHaveBeenCalled();

		// Relevant: the observed entity's value changes.
		client.add(1, 'name', 'Alicia');
		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenLastCalledWith({ id: 1, name: 'Alicia' });

		unsubscribe();
		client.add(1, 'name', 'Alicia-2');
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it('observeEntity() also fires when a brand-new attribute is added to the entity', () => {
		const client = createClient();
		const callback = vi.fn();
		client.add(1, 'name', 'Alice');
		client.observeEntity(1, callback);
		callback.mockClear();

		// A new attribute is part of the entity payload — it must wake the observer.
		client.add(1, 'age', 30);
		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenLastCalledWith({ id: 1, name: 'Alice', age: 30 });
	});
});
