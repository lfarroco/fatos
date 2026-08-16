/**
 * File-based adapter — one JSON snapshot file plus an append-only log per
 * database (design/04 persistence).
 *
 * Node-only. `save()` writes the serialized snapshot to a temp file in the
 * same directory and atomically renames it over the target, so a crash
 * mid-write never corrupts a previously saved snapshot (POSIX rename
 * semantics). After the rename it truncates the append log, so `save()` is
 * also the compaction checkpoint that keeps the log bounded.
 *
 * `append()` records one committed transaction plus its facts as a single
 * JSON line in `<snapshot path>.log` (O(transaction size), the rest of the
 * database is untouched). `load()` replays the snapshot followed by any log
 * entries newer than the snapshot's last transaction: a crash between an
 * append and the next checkpoint loses at most that partial trailing line
 * (dropped on read), and an entry already inside the snapshot is never
 * double-replayed.
 *
 * Values are persisted through the core wire tags (`$ref` / `$date` /
 * `$bigint`), so Date, bigint, and ref values round-trip losslessly.
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { Fact, TransactionRecord } from '@fatos/core';
import { deserializeLogEntry, deserializeSnapshot, serializeLogEntry, serializeSnapshot } from '../serialization';
import type { DatabaseSnapshot, StorageAdapter } from '../types';

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}

export class FileAdapter implements StorageAdapter {
	constructor(private readonly filePath: string) {}

	/** Append-only log path for this database: `<snapshot path>.log`. */
	private get logPath(): string {
		return `${this.filePath}.log`;
	}

	/**
	 * Appends one committed transaction (its ledger record plus its facts) as
	 * a single JSON line in the append log. O(transaction size).
	 */
	async append(transaction: TransactionRecord, facts: readonly Fact[]): Promise<void> {
		await fs.mkdir(dirname(this.logPath), { recursive: true });
		const line = `${JSON.stringify(serializeLogEntry(transaction, facts))}\n`;
		await fs.appendFile(this.logPath, line, 'utf8');
	}

	/**
	 * Reads and deserializes every complete log entry. A trailing line that
	 * fails to parse is treated as a crash mid-append and dropped; a malformed
	 * line in the middle of the log is a hard error.
	 */
	private async readLogEntries(): Promise<Array<{ transaction: TransactionRecord; facts: Fact[] }>> {
		let raw: string;
		try {
			raw = await fs.readFile(this.logPath, 'utf8');
		} catch (error) {
			if (isNodeError(error) && error.code === 'ENOENT') {
				return [];
			}
			throw error;
		}

		const lines = raw.split('\n');
		if (lines.length > 0 && lines[lines.length - 1] === '') {
			lines.pop();
		}

		const entries: Array<{ transaction: TransactionRecord; facts: Fact[] }> = [];
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index];
			if (line === '') {
				continue;
			}

			let payload: unknown;
			try {
				payload = JSON.parse(line) as unknown;
			} catch {
				if (index === lines.length - 1) {
					// Crash mid-append: tolerate the partial trailing line.
					break;
				}
				throw new Error(`FileAdapter: ${this.logPath} line ${index + 1} is not valid JSON`);
			}

			entries.push(deserializeLogEntry(payload));
		}

		return entries;
	}

	async load(): Promise<DatabaseSnapshot> {
		let snapshot: DatabaseSnapshot;
		try {
			const raw = await fs.readFile(this.filePath, 'utf8');
			let payload: unknown;
			try {
				payload = JSON.parse(raw) as unknown;
			} catch {
				throw new Error(`FileAdapter: ${this.filePath} is not valid JSON`);
			}
			snapshot = deserializeSnapshot(payload);
		} catch (error) {
			if (isNodeError(error) && error.code === 'ENOENT') {
				snapshot = { facts: [], transactions: [] };
			} else {
				throw error;
			}
		}

		// Replay log entries newer than the snapshot; anything at or below the
		// snapshot's last tx is already inside it (checkpoint-then-crash-before-
		// truncate must never double-replay).
		const maxTx = snapshot.transactions.length > 0 ? snapshot.transactions[snapshot.transactions.length - 1][0] : 0;

		const facts = snapshot.facts.slice();
		const transactions = snapshot.transactions.slice();
		for (const entry of await this.readLogEntries()) {
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
	 * Compaction checkpoint: atomically replaces the snapshot file (temp file
	 * + rename), then truncates the append log so the log never outlives the
	 * data it duplicates.
	 */
	async save(snapshot: DatabaseSnapshot): Promise<void> {
		const payload = serializeSnapshot(snapshot);
		const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		await fs.mkdir(dirname(this.filePath), { recursive: true });
		await fs.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
		await fs.rename(tmpPath, this.filePath);
		await this.truncateLog();
	}

	/** Deletes the append log; a missing log (no appends yet) is not an error. */
	private async truncateLog(): Promise<void> {
		try {
			await fs.unlink(this.logPath);
		} catch (error) {
			if (!(isNodeError(error) && error.code === 'ENOENT')) {
				throw error;
			}
		}
	}

	async close(): Promise<void> {
		// Nothing to release: each operation opens its own file handle.
	}
}

