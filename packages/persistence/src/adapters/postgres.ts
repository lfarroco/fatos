/**
 * PostgreSQL adapter — one row per database snapshot (design/04 persistence).
 *
 * Driver-injected: this package adds no `pg` dependency. Pass any object with
 * a pg-shaped `query` method. For a real `pg` Pool/Client:
 *
 * ```ts
 * import { Pool } from 'pg';
 * const pool = new Pool({ connectionString });
 * const adapter = new PostgresAdapter({ query: (sql, params) => pool.query(sql, params) });
 * ```
 *
 * `pg`'s `query(text, values)` returns `{ rows }`, which satisfies
 * {@link SQLExecutor}. The adapter creates a single-table store
 * (`fatos_snapshot`, configurable via `options.table`) holding the serialized
 * snapshot; `save()` upserts it in one statement (atomic per statement).
 * Placeholders are `$1`-style (PostgreSQL native). The adapter never closes a
 * pool it was handed — callers own their driver lifecycle.
 *
 * Values are persisted through the core wire tags (`$ref` / `$date` /
 * `$bigint`), so Date, bigint, and ref values round-trip losslessly.
 */

import { deserializeSnapshot, serializeSnapshot } from '../serialization';
import type { DatabaseSnapshot, StorageAdapter } from '../types';

/**
 * The minimal SQL surface the adapter needs. Structurally satisfied by a
 * wrapped `pg.Pool` / `pg.Client` (see file header).
 */
export interface SQLExecutor {
	query<T extends Record<string, unknown> = Record<string, unknown>>(
		sql: string,
		params?: readonly unknown[]
	): Promise<{ rows: readonly T[] }>;
}

export type PostgresAdapterOptions = {
	/** Table holding the snapshot row. Defaults to `fatos_snapshot`. */
	table?: string;
};

const DEFAULT_TABLE = 'fatos_snapshot';
const SNAPSHOT_ROW_ID = 1;

function quoteIdent(identifier: string): string {
	return `"${identifier.replace(/"/g, '""')}"`;
}

export class PostgresAdapter implements StorageAdapter {
	private readonly table: string;
	private initialized = false;

	constructor(private readonly executor: SQLExecutor, options: PostgresAdapterOptions = {}) {
		this.table = options.table ?? DEFAULT_TABLE;
	}

	private async ensureSchema(): Promise<void> {
		if (this.initialized) {
			return;
		}

		await this.executor.query(
			`CREATE TABLE IF NOT EXISTS ${quoteIdent(this.table)} (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)`
		);
		this.initialized = true;
	}

	private parsePayload(raw: unknown): DatabaseSnapshot {
		if (typeof raw !== 'string') {
			throw new Error('PostgresAdapter: snapshot payload column must be TEXT');
		}

		let payload: unknown;
		try {
			payload = JSON.parse(raw) as unknown;
		} catch {
			throw new Error('PostgresAdapter: stored snapshot payload is not valid JSON');
		}

		return deserializeSnapshot(payload);
	}

	async load(): Promise<DatabaseSnapshot> {
		await this.ensureSchema();

		const result = await this.executor.query<{ payload: unknown }>(
			`SELECT payload FROM ${quoteIdent(this.table)} WHERE id = $1`,
			[SNAPSHOT_ROW_ID]
		);
		const row = result.rows[0];
		if (!row) {
			return { facts: [], transactions: [] };
		}

		return this.parsePayload(row.payload);
	}

	async save(snapshot: DatabaseSnapshot): Promise<void> {
		await this.ensureSchema();

		const payload = serializeSnapshot(snapshot);
		await this.executor.query(
			`INSERT INTO ${quoteIdent(this.table)} (id, payload) VALUES ($1, $2) ` +
				`ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload`,
			[SNAPSHOT_ROW_ID, JSON.stringify(payload)]
		);
	}

	async close(): Promise<void> {
		// The injected executor is owned by the caller; nothing to release here.
	}
}

