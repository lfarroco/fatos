/**
 * FileAdapter tests — atomic JSON file round-trip, empty-file semantics,
 * validation errors on malformed content, and append-only log recovery
 * (replay, snapshot+log merge, compaction truncation, partial trailing line,
 * and tx <= snapshot-max skip).
 */

import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileAdapter } from '../adapters/file';
import { comparableFacts, makeRichSnapshot } from './fixtures';

const tempDirs: string[] = [];

async function makeTempFile(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'fatos-file-'));
	tempDirs.push(dir);
	return join(dir, 'snapshot.json');
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('FileAdapter', () => {
	it('returns an empty snapshot when the file does not exist', async () => {
		const adapter = new FileAdapter(await makeTempFile());
		await expect(adapter.load()).resolves.toEqual({ facts: [], transactions: [] });
	});

	it('round-trips a rich snapshot and restores an identical database', async () => {
		const snapshot = makeRichSnapshot();
		const filePath = await makeTempFile();
		const adapter = new FileAdapter(filePath);

		await adapter.save(snapshot);
		const loaded = await adapter.load();

		expect(comparableFacts(loaded.facts)).toEqual(comparableFacts(snapshot.facts));
		expect(loaded.transactions).toEqual(snapshot.transactions);
	});

	it('a reloaded database behaves identically (schema + tx numbering survive)', async () => {
		const snapshot = makeRichSnapshot();
		const filePath = await makeTempFile();
		const writer = new FileAdapter(filePath);
		await writer.save(snapshot);

		const reader = new FileAdapter(filePath);
		const loaded = await reader.load();

		const { createDatabase } = await import('@fatos/core');
		const restored = createDatabase();
		restored.restore(loaded);

		expect(restored.getSchemas().map((schema) => schema.ident).sort()).toEqual([
			'user/balance',
			'user/born',
			'user/name',
			'user/tags'
		]);
		// Next transaction continues after the last restored tx (3 committed txs).
		expect(restored.transact([['add', 3, 'user/name', 'Carol']])[0]).toEqual([3, 'user/name', 'Carol', 4, 'add']);
	});

	it('overwrites atomically: no temp files remain after save', async () => {
		const filePath = await makeTempFile();
		const adapter = new FileAdapter(filePath);

		await adapter.save(makeRichSnapshot());
		const entries = await fs.readdir(join(filePath, '..'));
		expect(entries.filter((entry) => entry.includes('tmp-'))).toEqual([]);

		await adapter.save({ facts: [], transactions: [] });
		await expect(adapter.load()).resolves.toEqual({ facts: [], transactions: [] });
	});

	it('throws a clear error on invalid JSON content', async () => {
		const filePath = await makeTempFile();
		await fs.writeFile(filePath, 'not json at all', 'utf8');

		const adapter = new FileAdapter(filePath);
		await expect(adapter.load()).rejects.toThrow(/not valid JSON/);
	});

	it('throws a clear error on a structurally invalid snapshot payload', async () => {
		const filePath = await makeTempFile();
		await fs.writeFile(filePath, JSON.stringify({ version: 1, facts: 'nope', transactions: [] }), 'utf8');

		const adapter = new FileAdapter(filePath);
		await expect(adapter.load()).rejects.toThrow(/Invalid snapshot payload/);
	});

	it('throws a clear error on a malformed fact tuple', async () => {
		const filePath = await makeTempFile();
		await fs.writeFile(
			filePath,
			JSON.stringify({ version: 1, facts: [[1, 'type']], transactions: [[1, 1, null]] }),
			'utf8'
		);

		const adapter = new FileAdapter(filePath);
		await expect(adapter.load()).rejects.toThrow(/fact at index 0 must be a 5-tuple/);
	});

	it('creates the parent directory on save', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'fatos-file-'));
		tempDirs.push(dir);
		const nested = join(dir, 'nested', 'deeper', 'snapshot.json');

		const adapter = new FileAdapter(nested);
		await adapter.save(makeRichSnapshot());

		await expect(fs.access(nested)).resolves.toBeUndefined();
	});

	it('replays append-only writes through load()', async () => {
		const filePath = await makeTempFile();
		const adapter = new FileAdapter(filePath);

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
	});

	it('merges the snapshot with newer log entries, in order, without duplication', async () => {
		const filePath = await makeTempFile();
		const adapter = new FileAdapter(filePath);
		const snapshot = makeRichSnapshot();

		await adapter.save(snapshot);
		await adapter.append([4, 4, null], [[3, 'user/name', 'Carol', 4, 'add']]);

		const loaded = await adapter.load();
		expect(comparableFacts(loaded.facts)).toEqual([...comparableFacts(snapshot.facts), [3, 'user/name', 'Carol', 4, 'add']]);
		expect(loaded.transactions).toEqual([...snapshot.transactions, [4, 4, null]]);
	});

	it('checkpoint truncates the append log after save()', async () => {
		const filePath = await makeTempFile();
		const adapter = new FileAdapter(filePath);

		await adapter.append([1, 1, null], [[1, 'type', 'user', 1, 'add']]);
		await adapter.append([2, 2, null], [[1, 'age', 30, 2, 'add']]);

		const logPath = `${filePath}.log`;
		await expect(fs.access(logPath)).resolves.toBeUndefined();

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

		const entries = await fs.readdir(join(filePath, '..'));
		expect(entries.filter((entry) => entry.endsWith('.log'))).toEqual([]);

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

	it('tolerates a partial trailing log line from a crash mid-append', async () => {
		const filePath = await makeTempFile();
		const adapter = new FileAdapter(filePath);

		await adapter.append([1, 1, null], [[1, 'type', 'user', 1, 'add']]);
		await fs.appendFile(`${filePath}.log`, '{"version":1,"transaction":', 'utf8');

		const loaded = await adapter.load();
		expect(loaded.transactions).toEqual([[1, 1, null]]);
		expect(loaded.facts).toEqual([[1, 'type', 'user', 1, 'add']]);
	});

	it('skips log entries whose tx is already inside the snapshot', async () => {
		const filePath = await makeTempFile();
		const adapter = new FileAdapter(filePath);
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
});
