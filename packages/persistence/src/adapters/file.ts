/**
 * File-based adapter — one JSON snapshot file per database (design/04
 * persistence).
 *
 * Node-only. `save()` writes the serialized snapshot to a temp file in the
 * same directory and atomically renames it over the target, so a crash
 * mid-write never corrupts a previously saved snapshot (POSIX rename
 * semantics). `load()` returns an empty snapshot when the file does not exist
 * yet and throws a descriptive error on malformed content.
 *
 * Values are persisted through the core wire tags (`$ref` / `$date` /
 * `$bigint`), so Date, bigint, and ref values round-trip losslessly.
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { deserializeSnapshot, serializeSnapshot } from '../serialization';
import type { DatabaseSnapshot, StorageAdapter } from '../types';

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}

export class FileAdapter implements StorageAdapter {
	constructor(private readonly filePath: string) {}

	async load(): Promise<DatabaseSnapshot> {
		let raw: string;
		try {
			raw = await fs.readFile(this.filePath, 'utf8');
		} catch (error) {
			if (isNodeError(error) && error.code === 'ENOENT') {
				return { facts: [], transactions: [] };
			}
			throw error;
		}

		let payload: unknown;
		try {
			payload = JSON.parse(raw) as unknown;
		} catch {
			throw new Error(`FileAdapter: ${this.filePath} is not valid JSON`);
		}

		return deserializeSnapshot(payload);
	}

	async save(snapshot: DatabaseSnapshot): Promise<void> {
		const payload = serializeSnapshot(snapshot);
		const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		await fs.mkdir(dirname(this.filePath), { recursive: true });
		await fs.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
		await fs.rename(tmpPath, this.filePath);
	}

	async close(): Promise<void> {
		// Nothing to release: each operation opens its own file handle.
	}
}

