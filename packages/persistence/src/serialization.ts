/**
 * Snapshot serialization shared by the durable adapters (file / postgres /
 * mongodb / indexeddb). Values inside facts and transaction metadata are
 * encoded with the core wire tags (`$ref` / `$lookupRef` / `$date` / `$bigint`,
 * design/03) so Date, bigint, and ref values survive a JSON round-trip
 * losslessly. The in-memory adapter stores engine values natively and does not
 * use this module.
 *
 * The per-entry serializers below are reused by the append-only log format
 * ({@link serializeLogEntry} / {@link deserializeLogEntry}): each log line is
 * one committed transaction plus its facts, so a crash mid-append never costs
 * more than that single line to repair (and `load()` in the file adapter drops
 * a partial trailing line).
 */

import { deserializeValue, serializeValue, type Fact, type TransactionRecord } from '@fatos/core';
import type { DatabaseSnapshot } from './types';

export type SerializedSnapshot = {
	readonly version: 1;
	readonly facts: readonly unknown[][];
	readonly transactions: readonly unknown[][];
};

/** One append-only log entry: a committed transaction and the facts it added. */
export type SerializedLogEntry = {
	readonly version: 1;
	readonly transaction: readonly [number, number, unknown];
	readonly facts: readonly unknown[][];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
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

/** Inverse of {@link serializeMetadata}. */
function deserializeMetadata(json: unknown): Record<string, unknown> | null {
	if (json === null) {
		return null;
	}

	if (!isRecord(json)) {
		throw new Error('Invalid snapshot payload: transaction metadata must be a record or null');
	}

	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(json)) {
		out[key] = deserializeValue(value);
	}
	return out;
}

/** Serializes one fact into its JSON-safe persisted 5-tuple. */
export function serializeFactEntry(fact: Fact): unknown[] {
	return [fact[0], fact[1], serializeValue(fact[2]), fact[3], fact[4]];
}

/** Inverse of {@link serializeFactEntry}; `index` feeds error messages. */
export function deserializeFactEntry(entry: unknown, index: number): Fact {
	if (!Array.isArray(entry) || entry.length !== 5) {
		throw new Error(`Invalid snapshot payload: fact at index ${index} must be a 5-tuple`);
	}

	const [eid, attribute, value, tx, op] = entry as unknown as readonly [
		unknown,
		unknown,
		unknown,
		unknown,
		unknown
	];
	if ((typeof eid !== 'number' && typeof eid !== 'string') || typeof attribute !== 'string') {
		throw new Error(`Invalid snapshot payload: fact at index ${index} has a malformed eid/attribute`);
	}
	if (typeof tx !== 'number' || (op !== 'add' && op !== 'retract')) {
		throw new Error(`Invalid snapshot payload: fact at index ${index} has a malformed tx/op`);
	}

	return [eid, attribute, deserializeValue(value), tx, op];
}

/** Serializes one transaction record into its JSON-safe 3-tuple. */
export function serializeTransactionEntry(transaction: TransactionRecord): unknown[] {
	return [transaction[0], transaction[1], serializeMetadata(transaction[2])];
}

/** Inverse of {@link serializeTransactionEntry}; `index` feeds error messages. */
export function deserializeTransactionEntry(entry: unknown, index: number): TransactionRecord {
	if (!Array.isArray(entry) || entry.length !== 3) {
		throw new Error(`Invalid snapshot payload: transaction at index ${index} must be a 3-tuple`);
	}

	const [tx, timestamp, metadata] = entry as unknown as readonly [unknown, unknown, unknown];
	if (typeof tx !== 'number' || typeof timestamp !== 'number') {
		throw new Error(`Invalid snapshot payload: transaction at index ${index} has a malformed tx/timestamp`);
	}

	return [tx, timestamp, deserializeMetadata(metadata)];
}

/** Converts a native snapshot into its JSON-safe persisted form. */
export function serializeSnapshot(snapshot: DatabaseSnapshot): SerializedSnapshot {
	return {
		version: 1,
		facts: snapshot.facts.map(serializeFactEntry),
		transactions: snapshot.transactions.map(serializeTransactionEntry)
	};
}

/**
 * Parses and validates a persisted snapshot payload back into native engine
 * values. Throws with a clear message on any structural violation.
 */
export function deserializeSnapshot(json: unknown): DatabaseSnapshot {
	if (!isRecord(json) || json.version !== 1 || !Array.isArray(json.facts) || !Array.isArray(json.transactions)) {
		throw new Error('Invalid snapshot payload: expected { version: 1, facts, transactions }');
	}

	const facts = json.facts.map((entry, index) => deserializeFactEntry(entry, index));
	const transactions = json.transactions.map((entry, index) => deserializeTransactionEntry(entry, index));
	return { facts, transactions };
}

/** Serializes one append-only log entry: a committed transaction plus its facts. */
export function serializeLogEntry(transaction: TransactionRecord, facts: readonly Fact[]): SerializedLogEntry {
	return {
		version: 1,
		transaction: serializeTransactionEntry(transaction) as [number, number, unknown],
		facts: facts.map(serializeFactEntry)
	};
}

/**
 * Parses and validates one append-only log entry back into native engine
 * values. Throws with a clear message on a malformed line.
 */
export function deserializeLogEntry(json: unknown): { transaction: TransactionRecord; facts: Fact[] } {
	if (!isRecord(json) || json.version !== 1 || !Array.isArray(json.transaction) || !Array.isArray(json.facts)) {
		throw new Error('Invalid log entry: expected { version: 1, transaction, facts }');
	}

	return {
		transaction: deserializeTransactionEntry(json.transaction, -1),
		facts: json.facts.map((entry, index) => deserializeFactEntry(entry, index))
	};
}
