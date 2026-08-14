/**
 * Export/import tests — pure serialization round-trips and the injectable
 * file I/O helpers (no DOM needed).
 */

import { describe, expect, it, vi } from 'vitest';
import { ref } from '@fatos/core';
import {
	SnapshotFormatError,
	createBrowserFileIo,
	defaultSnapshotFilename,
	deserializeSnapshot,
	downloadSnapshot,
	pickSnapshotFile,
	serializeSnapshot
} from './export-import';
import type { FileIo } from './export-import';
import type { FactSnapshot } from './snapshot';

function buildSnapshot(): FactSnapshot {
	return {
		facts: [
			[1, 'user/name', 'Alice', 1, 'add'],
			[1, 'user/born', new Date('1990-01-02T03:04:05.000Z'), 1, 'add'],
			[1, 'user/balance', 10n, 2, 'add'],
			[1, 'user/friend', ref(2), 2, 'add'],
			[2, 'user/name', 'Bob', 3, 'add']
		],
		transactions: [
			[1, 1000, { source: 'fixture' }],
			[2, 2000, { at: new Date('2024-01-01T00:00:00.000Z') }],
			[3, 3000, null]
		],
		capturedAt: 1234,
		url: 'https://example.test/'
	};
}

describe('serializeSnapshot / deserializeSnapshot', () => {
	it('serializes engine values to wire form and round-trips', () => {
		const text = serializeSnapshot(buildSnapshot());

		const parsed = JSON.parse(text) as Record<string, unknown>;
		expect(parsed.facts).toEqual([
			[1, 'user/name', 'Alice', 1, 'add'],
			[1, 'user/born', { $date: new Date('1990-01-02T03:04:05.000Z').getTime() }, 1, 'add'],
			[1, 'user/balance', { $bigint: '10' }, 2, 'add'],
			[1, 'user/friend', { $ref: 2 }, 2, 'add'],
			[2, 'user/name', 'Bob', 3, 'add']
		]);
		expect(parsed.transactions).toEqual([
			[1, 1000, { source: 'fixture' }],
			[2, 2000, { at: { $date: 1704067200000 } }],
			[3, 3000, null]
		]);
		expect(parsed.capturedAt).toBe(1234);
		expect(parsed.url).toBe('https://example.test/');

		const restored = deserializeSnapshot(text);
		expect(restored.facts).toEqual(parsed.facts);
		expect(restored.transactions).toEqual(parsed.transactions);
		expect(restored.capturedAt).toBe(1234);
		expect(restored.url).toBe('https://example.test/');
	});

	it('is idempotent for already-wire-form values', () => {
		const wire: FactSnapshot = {
			facts: [[1, 'user/born', { $date: 0 }, 1, 'add']],
			transactions: []
		};

		expect(JSON.parse(serializeSnapshot(wire))).toEqual({
			facts: [[1, 'user/born', { $date: 0 }, 1, 'add']],
			transactions: []
		});
	});

	it('drops undefined capturedAt/url fields', () => {
		const text = serializeSnapshot({ facts: [], transactions: [] });
		expect(JSON.parse(text)).toEqual({ facts: [], transactions: [] });
	});

	it('deserializes a plain snapshot and a versioned persistence envelope', () => {
		const plain = deserializeSnapshot(serializeSnapshot(buildSnapshot()));
		expect(plain.facts).toHaveLength(5);

		const versioned = deserializeSnapshot(
			JSON.stringify({
				version: 1,
				facts: [[1, 'a', 'x', 1, 'add']],
				transactions: [[1, 100, null]]
			})
		);
		expect(versioned.facts).toEqual([[1, 'a', 'x', 1, 'add']]);
		expect(versioned.transactions).toEqual([[1, 100, null]]);
	});

	it('throws SnapshotFormatError with clear messages', () => {
		expect(() => deserializeSnapshot('not json')).toThrow(SnapshotFormatError);
		expect(() => deserializeSnapshot('not json')).toThrow(/invalid snapshot JSON/);

		expect(() => deserializeSnapshot('{"facts": [], "transactions": "nope"}')).toThrow(SnapshotFormatError);
		expect(() => deserializeSnapshot('{"facts": [], "transactions": "nope"}')).toThrow(/invalid snapshot/);

		expect(() => deserializeSnapshot('{"facts": [[1, "a", "x", 1]], "transactions": []}')).toThrow(/invalid snapshot/);
	});
});

describe('downloadSnapshot / pickSnapshotFile', () => {
	function fakeFileIo(): FileIo {
		return {
			pickTextFile: vi.fn(async () => null),
			saveTextFile: vi.fn()
		};
	}

	it('downloadSnapshot saves the serialized snapshot under the given filename', () => {
		const io = fakeFileIo();
		const snapshot = buildSnapshot();

		downloadSnapshot(snapshot, 'my-snapshot.json', io);

		const save = io.saveTextFile as ReturnType<typeof vi.fn>;
		expect(save).toHaveBeenCalledTimes(1);
		expect(save.mock.calls[0]?.[0]).toBe('my-snapshot.json');
		const savedText = save.mock.calls[0]?.[1] as string;
		expect(JSON.parse(savedText)).toEqual(JSON.parse(serializeSnapshot(snapshot)));
	});

	it('downloadSnapshot uses a timestamped default filename', () => {
		const io = fakeFileIo();
		downloadSnapshot(buildSnapshot(), undefined, io);

		const save = io.saveTextFile as ReturnType<typeof vi.fn>;
		expect(save.mock.calls[0]?.[0]).toMatch(/^fatos-snapshot-.*\.json$/);
	});

	it('pickSnapshotFile resolves null when the picker is cancelled', async () => {
		const io = fakeFileIo();
		await expect(pickSnapshotFile(io)).resolves.toBeNull();
	});

	it('pickSnapshotFile parses the picked file into a FactSnapshot', async () => {
		const io: FileIo = {
			pickTextFile: async () => serializeSnapshot(buildSnapshot()),
			saveTextFile: vi.fn()
		};

		const picked = await pickSnapshotFile(io);
		expect(picked).not.toBeNull();
		expect(serializeSnapshot(picked as FactSnapshot)).toBe(serializeSnapshot(buildSnapshot()));
	});

	it('pickSnapshotFile rejects with a clear error for an invalid file', async () => {
		const io: FileIo = {
			pickTextFile: async () => '{"facts": "nope"}',
			saveTextFile: vi.fn()
		};

		await expect(pickSnapshotFile(io)).rejects.toThrow(SnapshotFormatError);
	});

	it('createBrowserFileIo degrades gracefully without a document', async () => {
		const io = createBrowserFileIo();
		await expect(io.pickTextFile()).resolves.toBeNull();
		expect(() => io.saveTextFile('x.json', '{}')).not.toThrow();
	});

	it('defaultSnapshotFilename ends with .json', () => {
		expect(defaultSnapshotFilename()).toMatch(/\.json$/);
	});
});
