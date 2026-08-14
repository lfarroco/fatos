/**
 * PostgresAdapter tests against a fake in-memory SQL driver (no real `pg`
 * needed). The fake emulates the single-table snapshot store the adapter uses.
 */

import { describe, it, expect } from 'vitest';
import { PostgresAdapter, type SQLExecutor } from '../adapters/postgres';
import { comparableFacts, makeRichSnapshot } from './fixtures';

/** A tiny fake `pg`-shaped store: CREATE TABLE / SELECT / INSERT ... ON CONFLICT. */
class FakeSqlStore implements SQLExecutor {
	private payload: string | null = null;
	readonly queries: { sql: string; params: readonly unknown[] }[] = [];

	async query<T extends Record<string, unknown> = Record<string, unknown>>(
		sql: string,
		params: readonly unknown[] = []
	): Promise<{ rows: readonly T[] }> {
		this.queries.push({ sql, params });

		if (sql.startsWith('CREATE TABLE')) {
			return { rows: [] };
		}

		if (sql.startsWith('SELECT')) {
			const rows: T[] = this.payload === null ? [] : [{ payload: this.payload } as T];
			return { rows };
		}

		if (sql.startsWith('INSERT')) {
			this.payload = String(params[1]);
			return { rows: [] };
		}

		return { rows: [] };
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

	it('uses the configured table name in SQL statements', async () => {
		const store = new FakeSqlStore();
		const adapter = new PostgresAdapter(store, { table: 'custom_snapshots' });

		await adapter.save({ facts: [], transactions: [] });
		expect(store.queries[0].sql).toContain('"custom_snapshots"');
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
});
