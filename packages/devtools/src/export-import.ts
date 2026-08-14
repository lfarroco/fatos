/**
 * Export/import of FactSnapshot JSON (Phase 6/7).
 *
 * `serializeSnapshot` / `deserializeSnapshot` are pure: they convert a
 * `FactSnapshot` (facts + transactions, engine values or already-wire values)
 * into a pretty-printed JSON document and back, with validation and clear
 * errors. The exported shape is the wire-form snapshot
 * `{ facts, transactions, capturedAt?, url? }` (values tagged with the core
 * wire tags `$ref` / `$lookupRef` / `$date` / `$bigint` so Date, bigint, and
 * ref values survive losslessly). The deserializer also accepts the
 * persistence envelope `{ version: 1, ... }`, so files written by the
 * `@fatos/persistence` adapters can be imported here too.
 *
 * `downloadSnapshot` / `pickSnapshotFile` are thin, document-guarded browser
 * helpers (Blob + anchor click / input[type=file] + FileReader). They accept
 * an injectable {@link FileIo} so tests can exercise them without a DOM; in
 * non-browser environments they degrade to no-ops / `null`.
 */

import { serializeValue } from '@fatos/core';
import { isFactSnapshot } from './snapshot';
import type { FactSnapshot } from './snapshot';

/** Thrown by {@link deserializeSnapshot} when the text is not snapshot JSON. */
export class SnapshotFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SnapshotFormatError';
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/** Serializes transaction metadata: null stays null, values are wire-tagged per key. */
function serializeMetadata(metadata: Record<string, unknown> | null): unknown {
	if (metadata === null) {
		return null;
	}

	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(metadata)) {
		out[key] = serializeValue(value);
	}
	return out;
}

/** JSON.stringify of the wire-form snapshot (values tagged via the core wire tags). */
export function serializeSnapshot(snapshot: FactSnapshot): string {
	return JSON.stringify(
		{
			facts: snapshot.facts.map((fact) => [fact[0], fact[1], serializeValue(fact[2]), fact[3], fact[4]]),
			transactions: snapshot.transactions.map((transaction) => [
				transaction[0],
				transaction[1],
				serializeMetadata(transaction[2])
			]),
			capturedAt: snapshot.capturedAt,
			url: snapshot.url
		},
		null,
		2
	);
}

/** Accepts the plain snapshot shape and the persistence `{ version: 1 }` envelope. */
function unwrapVersionedEnvelope(parsed: unknown): unknown {
	if (!isObject(parsed) || parsed['version'] !== 1) {
		return parsed;
	}

	return {
		facts: parsed['facts'],
		transactions: parsed['transactions'],
		capturedAt: parsed['capturedAt'],
		url: parsed['url']
	};
}

/**
 * Parses snapshot JSON back into a `FactSnapshot` (wire values are kept
 * verbatim; the controller normalizes them with `deserializeValue` on replay).
 * Throws {@link SnapshotFormatError} with a clear message when the text is not
 * valid JSON or fails the `FactSnapshot` shape contract.
 */
export function deserializeSnapshot(text: string): FactSnapshot {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch (error) {
		throw new SnapshotFormatError(`invalid snapshot JSON: ${error instanceof Error ? error.message : String(error)}`);
	}

	const candidate = unwrapVersionedEnvelope(parsed);
	if (!isFactSnapshot(candidate)) {
		throw new SnapshotFormatError(
			'invalid snapshot: expected { facts: [eid, attribute, value, tx, op][], transactions: [tx, timestamp, metadata][] }'
		);
	}

	return candidate;
}

/**
 * Injectable file I/O used by {@link downloadSnapshot} / {@link pickSnapshotFile}.
 * Tests inject fakes; the browser implementation is {@link createBrowserFileIo}.
 */
export type FileIo = {
	/** Reads the text of a user-picked file; resolves `null` when the picker is cancelled. */
	pickTextFile: () => Promise<string | null>;
	/** Saves `text` as a file download with the given `filename`. */
	saveTextFile: (filename: string, text: string) => void;
};

/** A default `fatos-snapshot-<timestamp>.json` download filename. */
export function defaultSnapshotFilename(): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	return `fatos-snapshot-${stamp}.json`;
}

/** The browser-backed {@link FileIo}: input[type=file] + FileReader, Blob + anchor click. */
export function createBrowserFileIo(): FileIo {
	return {
		pickTextFile(): Promise<string | null> {
			return new Promise((resolve, reject) => {
				if (typeof document === 'undefined') {
					resolve(null);
					return;
				}

				const input = document.createElement('input');
				input.type = 'file';
				input.accept = 'application/json,.json';
				input.style.display = 'none';
				document.body.appendChild(input);

				const cleanup = (): void => {
					input.remove();
				};

				input.addEventListener('change', () => {
					cleanup();
					const file = input.files?.[0];
					if (!file) {
						resolve(null);
						return;
					}

					const reader = new FileReader();
					reader.onload = () => {
						resolve(typeof reader.result === 'string' ? reader.result : null);
					};
					reader.onerror = () => {
						reject(new Error('could not read the selected file'));
					};
					reader.readAsText(file);
				});

				input.addEventListener('cancel', () => {
					cleanup();
					resolve(null);
				});

				input.click();
			});
		},
		saveTextFile(filename: string, text: string): void {
			if (typeof document === 'undefined' || typeof URL === 'undefined') {
				return;
			}

			const blob = new Blob([text], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement('a');
			anchor.href = url;
			anchor.download = filename;
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
			setTimeout(() => URL.revokeObjectURL(url), 0);
		}
	};
}

const browserFileIo = createBrowserFileIo();

/** Downloads the current snapshot as `<filename>` (default {@link defaultSnapshotFilename}). */
export function downloadSnapshot(
	snapshot: FactSnapshot,
	filename = defaultSnapshotFilename(),
	io: FileIo = browserFileIo
): void {
	io.saveTextFile(filename, serializeSnapshot(snapshot));
}

/**
 * Opens a file picker and parses the selected JSON into a `FactSnapshot`.
 * Resolves `null` when the picker is cancelled; rejects with
 * {@link SnapshotFormatError} when the file is not valid snapshot JSON.
 */
export async function pickSnapshotFile(io: FileIo = browserFileIo): Promise<FactSnapshot | null> {
	const text = await io.pickTextFile();
	if (text === null) {
		return null;
	}

	return deserializeSnapshot(text);
}

