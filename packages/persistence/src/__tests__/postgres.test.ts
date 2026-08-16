/**
 * PostgresAdapter tests against a fake in-memory SQL driver (no real `pg`
 * needed). The fake emulates the two-table store the adapter uses: the
 * snapshot row plus the id-keyed append log.
 */

import { describe, it, expect } from 'vitest';
import { PostgresAdapter, type SQLExecutor } from '../adapters/postgres';
import { comparableFacts, makeRichSnapshot } from './fixtures';

/** A tiny fake `pg`-shaped store: CREATE TABLE / SELECT / INSERT / DELETE. */
class FakeSqlStore implements SQLExecutor {
	private snapshotPayload: string | null = null;
	private readonly logRows = new Map<number, string>();
	readonly queries: { sql: string; params: readonly unknown[] }[] = [];

	async query<T extends Record<string, unknown> = Record<string, unknown>>(
		sql: string,
		params: readonly unknown[] = []
	): Promise<{ rows: readonly T[] }> {
		this.queries.push({ sql, params });

		if (sql.startsWith('CREATE TABLE')) {
			return { rows: [] };
		}

		const tableMatch = /"([^"]+)"/.exec(sql);
		const table = tableMatch?.[1];

		if (sql.startsWith('SELECT')) {
			if (table === 'fatos_snapshot') {
				const rows: T[] = this.snapshotPayload === null ? [] : [{ payload: this.snapshotPayload } as T];
				return { rows };
			}
			if (table === 'fatos_log') {
				const minId = Number(params[0]);
				const rows = [...this.logRows.entries()]
					.filter(([id]) => id > minId)
					.sort(([a], [b]) => a - b)
					.map(([, payload]) => ({ payload }) as T);
				return { rows };
			}
			return { rows: [] };
		}

		if (sql.startsWith('INSERT')) {
			if (table === 'fatos_snapshot') {
				this.snapshotPayload = String(params[1]);
			} else if (table === 'fatos_log') {
				this.logRows.set(Number(params[0]), String(params[1]));
			}
			return { rows: [] };
		}

		if (sql.startsWith('DELETE')) {
			const maxId = Number(params[0]);
			for (const id of [...this.logRows.keys()]) {
				if (id <= maxId) {
					this.logRows.delete(id);
				}
			}
			return { rows: [] };
		}

		return { rows: [] };
	}

	get logRowCount(): number {
		return this.logRows.size;
	}
}


describe('PostgresAdapter', () => {
	it('returns an empty snapshot when no row exists yet', async () => {
		const adapter = new PostgresAdapter(new FakeSqlStore());
		await expect(adapter.load()).resolves.toEqual({ facts: [], transactions: [] });
	});

	it('round-trips a rich snapshot through the fake driver', async () => {
		const store = new FakeSqlStore();
		const adapter = new PostgresAdapter(store);
		const snapshot = makeRichSnapshot();

		await adapter.save(snapshot);
		const loaded = await adapter.load();

		expect(comparableFacts(loaded.facts)).toEqual(comparableFacts(snapshot.facts));
		expect(loaded.transactions).toEqual(snapshot.transactions);

		// The snapshot is persisted as JSON in a single TEXT column.
		const insert = store.queries.find((query) => query.sql.startsWith('INSERT'));
		expect(insert).toBeDefined();
		expect(insert?.params[1]).toBeTypeOf('string');
	});

	it('a second adapter reading the same store sees the saved snapshot', async () => {
		const store = new FakeSqlStore();
		await new PostgresAdapter(store).save(makeRichSnapshot());

		const reader = new PostgresAdapter(store);
		const loaded = await reader.load();
		expect(loaded.facts.length).toBeGreaterThan(0);
		expect(loaded.transactions).toHaveLength(3);
	});

	it('uses the configured table names in SQL statements', async () => {
		const store = new FakeSqlStore();
		const adapter = new PostgresAdapter(store, { table: 'custom_snapshots', logTable: 'custom_log' });

		await adapter.save({ facts: [], transactions: [] });
		expect(store.queries[0].sql).toContain('"custom_snapshots"');
		expect(store.queries.some((query) => query.sql.includes('"custom_log"'))).toBe(true);
	});

	it('propagates driver errors', async () => {
		const failing: SQLExecutor = {
			async query() {
				throw new Error('connection refused');
			}
		};

		const adapter = new PostgresAdapter(failing);
		await expect(adapter.load()).rejects.toThrow(/connection refused/);
	});

	it('replays append-only writes through load()', async () => {
		const store = new FakeSqlStore();
		const adapter = new PostgresAdapter(store);

		await adapter.append([1, 1, null], [[1, 'type', 'user', 1, 'add']]);
		await adapter.append([2, 2, null], [[1, 'age', 30, 2, 'add']]);

		const loaded = await adapter.load();
		expect(loaded.transactions).toEqual([
			[1, 1, null],
			[2, 2, null]
		]);
		expect(loaded.facts).toEqual([
			[1, 'type', 'user', 1, 'add'],
			[1, 'age', 30, 2, 'add']
		]);

		// Appends land in the log table as single-row inserts (id = tx) with
		// ON CONFLICT DO NOTHING so a re-append never double-replays.
		const insert = store.queries.find(
			(query) => query.sql.startsWith('INSERT') && query.sql.includes('fatos_log')
		);
		expect(insert?.sql).toContain('ON CONFLICT (id) DO NOTHING');
		expect(insert?.params[0]).toBe(1);
	});

	it('merges the snapshot with newer log entries, in order, without duplication', async () => {
		const store = new FakeSqlStore();
		const adapter = new PostgresAdapter(store);
		const snapshot = makeRichSnapshot();

		await adapter.save(snapshot);
		await adapter.append([4, 4, null], [[3, 'user/name', 'Carol', 4, 'add']]);

		const loaded = await adapter.load();
		expect(comparableFacts(loaded.facts)).toEqual([
			...comparableFacts(snapshot.facts),
			[3, 'user/name', 'Carol', 4, 'add']
		]);
		expect(loaded.transactions).toEqual([...snapshot.transactions, [4, 4, null]]);
	});

	it('checkpoint truncates the append log after save()', async () => {
		const store = new FakeSqlStore();
		const adapter = new PostgresAdapter(store);

		await adapter.append([1, 1, null], [[1, 'type', 'user', 1, 'add']]);
		await adapter.append([2, 2, null], [[1, 'age', 30, 2, 'add']]);
		expect(store.logRowCount).toBe(2);

		await adapter.save({
			facts: [
				[1, 'type', 'user', 1, 'add'],
				[1, 'age', 30, 2, 'add']
			],
			transactions: [
				[1, 1, null],
				[2, 2, null]
			]
		});

		// The checkpoint deletes log rows at or below the snapshot's last tx.
		expect(store.logRowCount).toBe(0);

		const loaded = await adapter.load();
		expect(loaded.transactions).toEqual([
			[1, 1, null],
			[2, 2, null]
		]);
		expect(loaded.facts).toEqual([
			[1, 'type', 'user', 1, 'add'],
			[1, 'age', 30, 2, 'add']
		]);
	});

	it('skips log entries whose tx is already inside the snapshot', async () => {
		const store = new FakeSqlStore();
		const adapter = new PostgresAdapter(store);
		const snapshot = makeRichSnapshot();

		await adapter.save(snapshot);
		// Re-append the last snapshot transaction: it was already checkpointed
		// (crash between checkpoint and log truncate must not double-replay).
		const lastTx = snapshot.transactions[snapshot.transactions.length - 1];
		await adapter.append(lastTx, snapshot.facts.filter((fact) => fact[3] === lastTx[0]));

		const loaded = await adapter.load();
		expect(comparableFacts(loaded.facts)).toEqual(comparableFacts(snapshot.facts));
		expect(loaded.transactions).toEqual(snapshot.transactions);
	});

	it('save-then-append-then-load round-trip preserves transaction order', async () => {
		const store = new FakeSqlStore();
		const adapter = new PostgresAdapter(store);

		await adapter.save({
			facts: [
				[1, 'type', 'user', 1, 'add'],
				[1, 'age', 30, 2, 'add']
			],
			transactions: [
				[1, 1, null],
				[2, 2, null]
			]
		});
		await adapter.append([3, 3, null], [[1, 'name', 'Alice', 3, 'add']]);

		const loaded = await adapter.load();
		expect(loaded.transactions).toEqual([
			[1, 1, null],
			[2, 2, null],
			[3, 3, null]
		]);
		expect(loaded.facts).toEqual([
			[1, 'type', 'user', 1, 'add'],
			[1, 'age', 30, 2, 'add'],
			[1, 'name', 'Alice', 3, 'add']
		]);
	});
});
