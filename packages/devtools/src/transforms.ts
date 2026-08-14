/**
 * Pure data transforms for the DevTools inspector (design/04 P4). No DOM, no
 * side effects — everything here is unit-testable in a plain node environment.
 */

import { LOOKUP_REF_BRAND, REF_BRAND } from '@fatos/core';
import type { DiffResult, FactOperation } from '@fatos/core';
import type { EntityId, Fact, FactDatabase, TransactionRecord } from '@fatos/client';
import type { FactSnapshot } from './snapshot';

export type TimelineEntry = {
	tx: number;
	timestamp: number;
	factCount: number;
	metadata: Record<string, unknown> | null;
};

export type FactFilter = {
	entity?: EntityId;
	attribute?: string;
	tx?: number;
	op?: FactOperation;
};

/**
 * Stable display/identity key for a stored value. Handles primitives, Date,
 * bigint, arrays, branded refs/lookup refs, and plain objects so two
 * structurally equal values always produce the same key (Date by epoch,
 * bigint by string form, refs by target).
 */
export function stableValueKey(value: unknown): string {
	if (value === null) {
		return 'null';
	}

	if (typeof value === 'string') {
		return `s:${value}`;
	}
	if (typeof value === 'number') {
		return `n:${String(value)}`;
	}
	if (typeof value === 'boolean') {
		return `b:${String(value)}`;
	}
	if (typeof value === 'bigint') {
		return `big:${value.toString()}`;
	}
	if (value instanceof Date) {
		return `date:${value.getTime()}`;
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableValueKey(item)).join(',')}]`;
	}
	if (typeof value === 'object') {
		const record = value as Record<PropertyKey, unknown>;
		if (REF_BRAND in record) {
			return `ref:${stableValueKey(record[REF_BRAND])}`;
		}
		if (LOOKUP_REF_BRAND in record) {
			const pair = record[LOOKUP_REF_BRAND] as readonly [string, unknown];
			return `lookupRef:${pair[0]}:${stableValueKey(pair[1])}`;
		}
		return `obj:${JSON.stringify(value)}`;
	}

	return `${typeof value}:${String(value)}`;
}

function factKey(fact: Fact): string {
	return `${String(fact[0])}\u0000${fact[1]}\u0000${stableValueKey(fact[2])}\u0000${fact[3]}\u0000${fact[4]}`;
}

/**
 * Groups facts by entity, preserving fact order and first-appearance entity
 * order (a `Map` keyed by entity id).
 */
export function groupFactsByEntity(facts: readonly Fact[]): Map<EntityId, Fact[]> {
	const groups = new Map<EntityId, Fact[]>();
	for (const fact of facts) {
		const group = groups.get(fact[0]);
		if (group === undefined) {
			groups.set(fact[0], [fact]);
		} else {
			group.push(fact);
		}
	}
	return groups;
}

/**
 * Builds the timeline entries (tx, timestamp, fact count, metadata) for the
 * transaction ledger. Fact counts are derived from the fact log when supplied
 * (second argument); without facts every entry reports 0.
 */
export function computeTimeline(
	transactions: readonly TransactionRecord[],
	facts: readonly Fact[] = []
): TimelineEntry[] {
	const counts = new Map<number, number>();
	for (const fact of facts) {
		counts.set(fact[3], (counts.get(fact[3]) ?? 0) + 1);
	}

	return transactions.map(([tx, timestamp, metadata]) => ({
		tx,
		timestamp,
		factCount: counts.get(tx) ?? 0,
		metadata
	}));
}

/**
 * Diff between two snapshots of the fact log: `added` = facts present in B
 * but not A, `retracted` = facts present in A but not B. Facts are compared by
 * full identity (eid, attribute, value, tx, op), so unchanged append-only
 * facts are never reported.
 */
export function computeDiff(factsA: readonly Fact[], factsB: readonly Fact[]): DiffResult;
/**
 * Diff between two transactions of a live database, wrapping the core
 * `FactDatabase.diff(txA, txB)` primitive (facts committed in
 * (min(txA, txB), max(txA, txB)] grouped by operation).
 */
export function computeDiff(txA: number, txB: number, db: FactDatabase): DiffResult;
export function computeDiff(
	first: readonly Fact[] | number,
	second: readonly Fact[] | number,
	db?: FactDatabase
): DiffResult {
	if (typeof first === 'number' && typeof second === 'number' && db !== undefined) {
		return db.diff(first, second);
	}

	const factsA = first as readonly Fact[];
	const factsB = second as readonly Fact[];
	const keysA = new Set(factsA.map((fact) => factKey(fact)));
	const keysB = new Set(factsB.map((fact) => factKey(fact)));

	return {
		added: factsB.filter((fact) => !keysA.has(factKey(fact))),
		retracted: factsA.filter((fact) => !keysB.has(factKey(fact)))
	};
}

/**
 * Formats a stored value for display: Date → ISO, bigint → `123n`, refs →
 * `#<target>`, lookup refs → `[attr value]`, arrays/objects → compact JSON,
 * everything else → its string form.
 */
export function formatValue(value: unknown): string {
	if (value === null) {
		return 'null';
	}

	switch (typeof value) {
		case 'string':
		case 'number':
		case 'boolean':
			return String(value);
		case 'bigint':
			return `${value.toString()}n`;
		case 'undefined':
			return 'undefined';
		default:
			break;
	}

	if (value instanceof Date) {
		return value.toISOString();
	}

	if (Array.isArray(value)) {
		return `[${value.map((item) => formatValue(item)).join(', ')}]`;
	}

	if (typeof value === 'object') {
		const record = value as Record<PropertyKey, unknown>;
		if (REF_BRAND in record) {
			return `#${formatValue(record[REF_BRAND])}`;
		}
		if (LOOKUP_REF_BRAND in record) {
			const pair = record[LOOKUP_REF_BRAND] as readonly [string, unknown];
			return `[${pair[0]} ${formatValue(pair[1])}]`;
		}
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}

	return String(value);
}

/**
 * Filters a fact log by entity / attribute / transaction / operation. All
 * criteria are optional; omitted criteria match everything.
 */
export function filterFacts(facts: readonly Fact[], filter: FactFilter = {}): Fact[] {
	return facts.filter((fact) => {
		if (filter.entity !== undefined && fact[0] !== filter.entity) {
			return false;
		}
		if (filter.attribute !== undefined && fact[1] !== filter.attribute) {
			return false;
		}
		if (filter.tx !== undefined && fact[3] !== filter.tx) {
			return false;
		}
		if (filter.op !== undefined && fact[4] !== filter.op) {
			return false;
		}
		return true;
	});
}

/** The facts committed at or before `tx` — the head of the log at a point in time. */
export function factsAtOrBefore(facts: readonly Fact[], tx: number): Fact[] {
	return facts.filter((fact) => fact[3] <= tx);
}

/** The transaction ledger entries at or before `tx`. */
export function transactionsAtOrBefore(transactions: readonly TransactionRecord[], tx: number): TransactionRecord[] {
	return transactions.filter(([transactionTx]) => transactionTx <= tx);
}

/**
 * Builds the point-in-time `FactSnapshot` for transaction `tx` (Phase 6 time
 * travel): facts and transactions at or before `tx`, keeping the restore
 * invariants (facts ascending by tx, transaction ledger strictly ascending,
 * tx sets matching exactly), so the result can be fed straight back into
 * `db.restore()` / `DevtoolsPanelController.setSnapshot`. Out-of-range `tx`
 * values clamp naturally: below the first transaction yields an empty
 * snapshot, above the last yields the full snapshot.
 */
export function buildScopedSnapshot(snapshot: FactSnapshot, tx: number): FactSnapshot {
	const facts = factsAtOrBefore(snapshot.facts, tx);
	const transactions = transactionsAtOrBefore(snapshot.transactions, tx);
	return {
		facts,
		transactions,
		capturedAt: snapshot.capturedAt,
		url: snapshot.url
	};
}

