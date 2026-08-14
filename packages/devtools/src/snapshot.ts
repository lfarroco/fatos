/**
 * The snapshot contract between a running Fatos app (the inspected page) and
 * the DevTools inspector (design/04 P4).
 *
 * A page publishes a `FactSnapshot` through the browser devtools bridge
 * (`createBrowserDevtoolsBridge().publishSnapshot(...)`); the content script
 * relays the payload verbatim, and the panel validates it with
 * {@link isFactSnapshot} before feeding it to the `DevtoolsPanelController`.
 *
 * The shape mirrors the core `DatabaseSnapshot` so a `db.restore()` replay is
 * exact:
 *
 * ```ts
 * {
 *   facts: [eid, attribute, value, tx, op][], // append-only log, ascending tx
 *   transactions: [tx, timestamp, metadata][], // strictly ascending tx
 *   capturedAt?: number, // when the snapshot was captured (informational)
 *   url?: string // inspected page URL (informational)
 * }
 * ```
 *
 * `value` accepts both engine values (Date / bigint / branded refs) and their
 * JSON-wire forms (`{ $date }`, `{ $bigint }`, `{ $ref }`, `{ $lookupRef }`) —
 * the controller normalizes wire values with `deserializeValue` before replay.
 * Facts must be ordered by ascending tx and transactions strictly ascending
 * (the invariants `FactDatabase.restore()` enforces); payloads that violate
 * the shape are rejected and the panel shows "waiting for snapshot".
 */

import type { Fact, TransactionRecord } from '@fatos/client';

export type FactSnapshot = {
	facts: readonly Fact[];
	transactions: readonly TransactionRecord[];
	capturedAt?: number;
	url?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isEntityId(value: unknown): boolean {
	return typeof value === 'number' || typeof value === 'string';
}

function isFactTuple(value: unknown): value is Fact {
	if (!Array.isArray(value) || value.length !== 5) {
		return false;
	}

	const [eid, attribute, , tx, op] = value;
	return (
		isEntityId(eid)
		&& typeof attribute === 'string'
		&& Number.isInteger(tx)
		&& (tx as number) >= 1
		&& (op === 'add' || op === 'retract')
	);
}

function isTransactionTuple(value: unknown): value is TransactionRecord {
	if (!Array.isArray(value) || value.length !== 3) {
		return false;
	}

	const [tx, timestamp, metadata] = value;
	return (
		Number.isInteger(tx)
		&& (tx as number) >= 1
		&& typeof timestamp === 'number'
		&& (metadata === null || isObject(metadata))
	);
}

/**
 * Shape guard for bridge snapshot payloads. Checks the structural contract
 * (facts + transactions tuples, field types); ordering invariants are left to
 * `FactDatabase.restore()` and surfaced by the controller as a lastError.
 */
export function isFactSnapshot(value: unknown): value is FactSnapshot {
	if (!isObject(value) || !Array.isArray(value.facts) || !Array.isArray(value.transactions)) {
		return false;
	}

	for (const fact of value.facts) {
		if (!isFactTuple(fact)) {
			return false;
		}
	}

	for (const transaction of value.transactions) {
		if (!isTransactionTuple(transaction)) {
			return false;
		}
	}

	return true;
}
