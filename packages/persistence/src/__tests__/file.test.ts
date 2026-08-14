/**
 * FileAdapter tests — atomic JSON file round-trip, empty-file semantics, and
 * validation errors on malformed content.
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
});
