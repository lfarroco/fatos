/**
 * PostgreSQL adapter — one row per database snapshot plus an append-only
 * transaction log (design/04 persistence).
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
 * {@link SQLExecutor}. The adapter creates a two-table store: the snapshot row
 * (`fatos_snapshot`, configurable via `options.table`) holding the serialized
 * snapshot, and an append log (`fatos_log`, configurable via
 * `options.logTable`) holding one row per committed transaction (id = tx).
 * `append()` inserts one log row with `ON CONFLICT (id) DO NOTHING`
 * (O(transaction size)); `load()` replays the snapshot plus log rows newer
 * than the snapshot's last tx (a checkpoint-then-crash-before-truncate never
 * double-replays); `save()` upserts the snapshot atomically and then deletes
 * log rows at or below the snapshot's last tx — the compaction checkpoint that
 * keeps the log bounded. Placeholders are `$1`-style (PostgreSQL native). The
 * adapter never closes a pool it was handed — callers own their driver
 * lifecycle.
 *
 * Values are persisted through the core wire tags (`$ref` / `$date` /
 * `$bigint`), so Date, bigint, and ref values round-trip losslessly.
 */

import type { Fact, TransactionRecord } from '@fatos/core';
import { deserializeLogEntry, deserializeSnapshot, serializeLogEntry, serializeSnapshot } from '../serialization';
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
	/** Table holding the append-only transaction log. Defaults to `fatos_log`. */
	logTable?: string;
};

const DEFAULT_TABLE = 'fatos_snapshot';
const DEFAULT_LOG_TABLE = 'fatos_log';
const SNAPSHOT_ROW_ID = 1;

function quoteIdent(identifier: string): string {
	return `"${identifier.replace(/"/g, '""')}"`;
}

export class PostgresAdapter implements StorageAdapter {
	private readonly table: string;
	private readonly logTable: string;
	private initialized = false;

	constructor(private readonly executor: SQLExecutor, options: PostgresAdapterOptions = {}) {
		this.table = options.table ?? DEFAULT_TABLE;
		this.logTable = options.logTable ?? DEFAULT_LOG_TABLE;
	}

	private async ensureSchema(): Promise<void> {
		if (this.initialized) {
			return;
		}

		await this.executor.query(
			`CREATE TABLE IF NOT EXISTS ${quoteIdent(this.table)} (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)`
		);
		await this.executor.query(
			`CREATE TABLE IF NOT EXISTS ${quoteIdent(this.logTable)} (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)`
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

	private parseLogPayload(raw: unknown): { transaction: TransactionRecord; facts: Fact[] } {
		if (typeof raw !== 'string') {
			throw new Error('PostgresAdapter: log payload column must be TEXT');
		}

		let payload: unknown;
		try {
			payload = JSON.parse(raw) as unknown;
		} catch {
			throw new Error('PostgresAdapter: stored log payload is not valid JSON');
		}

		return deserializeLogEntry(payload);
	}

	async load(): Promise<DatabaseSnapshot> {
		await this.ensureSchema();

		const result = await this.executor.query<{ payload: unknown }>(
			`SELECT payload FROM ${quoteIdent(this.table)} WHERE id = $1`,
			[SNAPSHOT_ROW_ID]
		);
		const row = result.rows[0];
		const snapshot = row ? this.parsePayload(row.payload) : { facts: [], transactions: [] };

		// Replay log rows newer than the snapshot; anything at or below the
		// snapshot's last tx is already inside it (checkpoint-then-crash-before-
		// truncate must never double-replay).
		const maxTx = snapshot.transactions.length > 0 ? snapshot.transactions[snapshot.transactions.length - 1][0] : 0;
		const logResult = await this.executor.query<{ payload: unknown }>(
			`SELECT payload FROM ${quoteIdent(this.logTable)} WHERE id > $1 ORDER BY id`,
			[maxTx]
		);

		const facts = snapshot.facts.slice();
		const transactions = snapshot.transactions.slice();
		for (const logRow of logResult.rows) {
			const entry = this.parseLogPayload(logRow.payload);
			if (entry.transaction[0] > maxTx) {
				transactions.push(entry.transaction);
				for (const fact of entry.facts) {
					facts.push(fact);
				}
			}
		}

		return { facts, transactions };
	}

	/**
	 * Appends one committed transaction (its ledger record plus its facts) as
	 * a single log row (id = tx). `ON CONFLICT DO NOTHING` keeps a
	 * checkpoint-then-crash-before-truncate from double-replaying.
	 */
	async append(transaction: TransactionRecord, facts: readonly Fact[]): Promise<void> {
		await this.ensureSchema();

		const payload = serializeLogEntry(transaction, facts);
		await this.executor.query(
			`INSERT INTO ${quoteIdent(this.logTable)} (id, payload) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
			[transaction[0], JSON.stringify(payload)]
		);
	}

	/**
	 * Compaction checkpoint: atomically upserts the snapshot row, then deletes
	 * log rows at or below the snapshot's last tx so the log never outlives
	 * the data it duplicates.
	 */
	async save(snapshot: DatabaseSnapshot): Promise<void> {
		await this.ensureSchema();

		const payload = serializeSnapshot(snapshot);
		await this.executor.query(
			`INSERT INTO ${quoteIdent(this.table)} (id, payload) VALUES ($1, $2) ` +
				`ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload`,
			[SNAPSHOT_ROW_ID, JSON.stringify(payload)]
		);

		const maxTx = snapshot.transactions.length > 0 ? snapshot.transactions[snapshot.transactions.length - 1][0] : 0;
		await this.executor.query(`DELETE FROM ${quoteIdent(this.logTable)} WHERE id <= $1`, [maxTx]);
	}

	async close(): Promise<void> {
		// The injected executor is owned by the caller; nothing to release here.
	}
}

