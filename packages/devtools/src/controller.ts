/**
 * `DevtoolsPanelController` — the framework-free core of the inspector panel
 * (design/04 P4).
 *
 * Owns the current snapshot state and a Fatos client rebuilt from that
 * snapshot (`createClient(createDatabase())` + `db.restore(...)`), so every
 * read — facts, transactions, diffs, and the query console — runs against a
 * real database that behaves exactly like the inspected app's. Tabs register
 * render callbacks and are notified when state they depend on changes.
 */

import { createClient } from '@fatos/client';
import type { FatosClient, Fact, QuerySpec, QueryTerm, SchemaInfo, TransactionRecord } from '@fatos/client';
import { createDatabase, deserializeValue } from '@fatos/core';
import type { DiffResult, FactDatabase } from '@fatos/core';
import { deserializeSnapshot, serializeSnapshot } from './export-import';
import { isFactSnapshot } from './snapshot';
import type { FactSnapshot } from './snapshot';
import { buildScopedSnapshot } from './transforms';

export type DevtoolsTabId = 'facts' | 'entities' | 'timeline' | 'diff' | 'query' | 'time-travel' | 'graph';

export type DevtoolsRenderCallback = (controller: DevtoolsPanelController) => void;

/** Normalizes wire-tagged values (`$date` / `$bigint` / `$ref` / `$lookupRef`) back to engine values. */
function normalizeSnapshot(snapshot: FactSnapshot): FactSnapshot {
	return {
		...snapshot,
		facts: snapshot.facts.map(
			(fact) => [fact[0], fact[1], deserializeValue(fact[2]), fact[3], fact[4]] as Fact
		)
	};
}

export class DevtoolsPanelController {
	private snapshot: FactSnapshot | null = null;
	/** The wire-value-normalized replay source used to rebuild scoped clients. */
	private normalizedSnapshot: FactSnapshot | null = null;
	/** The full snapshot database — diffs always run against this, never the scoped one. */
	private fullDb: FactDatabase | null = null;
	private db: FactDatabase | null = null;
	private client: FatosClient | null = null;
	private activeTab: DevtoolsTabId = 'facts';
	private lastDiff: DiffResult | null = null;
	private lastTimeTravelDiff: DiffResult | null = null;
	private lastQueryRows: QueryTerm[][] | null = null;
	private lastQuerySpec: QuerySpec | null = null;
	private lastQueryError: string | null = null;
	private lastError: string | null = null;
	/** The pinned time-travel transaction, or `null` for the latest state. */
	private timeTravelTx: number | null = null;
	private renderCallbacks = new Map<DevtoolsTabId, DevtoolsRenderCallback>();

	/**
	 * Replaces the current snapshot and rebuilds the client database from it.
	 * Returns `false` (and records a `lastError`) when the payload is not a
	 * valid `FactSnapshot` or `db.restore()` rejects it; the previous state is
	 * kept in that case. Notifies every tab in both outcomes.
	 */
	setSnapshot(snapshot: FactSnapshot): boolean {
		if (!isFactSnapshot(snapshot)) {
			this.lastError = 'snapshot payload is not a valid FactSnapshot (expected { facts, transactions })';
			this.notifyAll();
			return false;
		}

		const db = createDatabase();
		const normalized = normalizeSnapshot(snapshot);
		try {
			db.restore(normalized);
		} catch (error) {
			this.lastError = `snapshot rejected: ${error instanceof Error ? error.message : String(error)}`;
			this.notifyAll();
			return false;
		}

		this.snapshot = snapshot;
		this.normalizedSnapshot = normalized;
		this.fullDb = db;
		this.db = db;
		this.client = createClient(db);
		this.timeTravelTx = null;
		this.lastError = null;
		this.lastDiff = null;
		this.lastTimeTravelDiff = null;
		this.lastQueryRows = null;
		this.lastQuerySpec = null;
		this.lastQueryError = null;
		this.notifyAll();
		return true;
	}

	hasSnapshot(): boolean {
		return this.client !== null;
	}

	getFacts(): readonly Fact[] {
		return this.client?.getFacts() ?? [];
	}

	getTransactions(): readonly TransactionRecord[] {
		return this.client?.getTransactions() ?? [];
	}

	getSnapshot(): FactSnapshot | null {
		return this.snapshot;
	}

	/** Schema declarations of the current (scoped) client, used by the graph tab. */
	getSchemas(): SchemaInfo[] {
		return this.client?.getSchemas() ?? [];
	}

	/** Last error from `setSnapshot` (invalid payload / rejected restore), if any. */
	getLastError(): string | null {
		return this.lastError;
	}

	/**
	 * Serializes the current snapshot to its JSON wire form (Phase 6 export).
	 * Throws when no snapshot is loaded yet.
	 */
	exportSnapshot(): string {
		if (this.snapshot === null) {
			throw new Error('no snapshot loaded; nothing to export');
		}

		return serializeSnapshot(this.snapshot);
	}

	/**
	 * Parses snapshot JSON and rebuilds the client state from it (Phase 6
	 * import): equivalent to `setSnapshot(deserializeSnapshot(text))`. Returns
	 * `false` (and records a `lastError`) when the text is not valid snapshot
	 * JSON; the previous state is kept in that case. Notifies every tab in both
	 * outcomes.
	 */
	importSnapshot(text: string): boolean {
		let snapshot: FactSnapshot;
		try {
			snapshot = deserializeSnapshot(text);
		} catch (error) {
			this.lastError = `import rejected: ${error instanceof Error ? error.message : String(error)}`;
			this.notifyAll();
			return false;
		}

		return this.setSnapshot(snapshot);
	}

	/**
	 * Diffs the transactions `txA` and `txB` against the snapshot database
	 * (wraps `FactDatabase.diff`). Returns `null` when no snapshot is loaded.
	 */
	getDiff(txA: number, txB: number): DiffResult | null {
		const db = this.fullDb ?? this.db;
		if (db === null) {
			this.lastDiff = null;
			this.notify('diff');
			return null;
		}

		this.lastDiff = db.diff(txA, txB);
		this.notify('diff');
		return this.lastDiff;
	}

	getLastDiff(): DiffResult | null {
		return this.lastDiff;
	}

	/**
	 * Pins the client to the state at transaction `tx` (Phase 6 time travel):
	 * the client is rebuilt from a snapshot scoped to facts/transactions at or
	 * before `tx` (`buildScopedSnapshot`), so the Facts/Entities/Query tabs all
	 * reflect that point in time. Pass `null` to return to the latest state.
	 * The full snapshot database is kept for diffs. Returns `false` (and
	 * records a `lastError`) when no snapshot is loaded. Notifies every tab.
	 */
	setTimeTravelTx(tx: number | null): boolean {
		if (this.normalizedSnapshot === null || this.client === null) {
			this.lastError = 'no snapshot loaded; nothing to time travel over';
			this.notifyAll();
			return false;
		}

		if (tx !== null && (!Number.isInteger(tx) || tx < 1)) {
			this.lastError = `invalid time-travel tx ${String(tx)}: expected a positive integer or null`;
			this.notifyAll();
			return false;
		}

		const scopedSnapshot = tx === null ? this.normalizedSnapshot : buildScopedSnapshot(this.normalizedSnapshot, tx);
		const db = createDatabase();
		try {
			db.restore(scopedSnapshot);
		} catch (error) {
			this.lastError = `time-travel rejected: ${error instanceof Error ? error.message : String(error)}`;
			this.notifyAll();
			return false;
		}

		this.db = db;
		this.client = createClient(db);
		this.timeTravelTx = tx;
		this.lastError = null;
		this.lastDiff = null;
		this.lastQueryRows = null;
		this.lastQuerySpec = null;
		this.lastQueryError = null;
		this.notifyAll();
		return true;
	}

	/** The pinned time-travel transaction, or `null` when viewing the latest state. */
	getTimeTravelTx(): number | null {
		return this.timeTravelTx;
	}

	/**
	 * The diff between `tx - 1` and `tx` against the full snapshot database —
	 * what the selected time-travel step added/retracted. Stores the result
	 * (read back with {@link getLastTimeTravelDiff}) without notifying, so tab
	 * renders can read it after `setTimeTravelTx` notified. Returns `null`
	 * when no snapshot is loaded.
	 */
	getTimeTravelDiff(tx: number): DiffResult | null {
		const db = this.fullDb ?? this.db;
		if (db === null) {
			this.lastTimeTravelDiff = null;
			return null;
		}

		this.lastTimeTravelDiff = db.diff(Math.max(0, tx - 1), tx);
		return this.lastTimeTravelDiff;
	}

	getLastTimeTravelDiff(): DiffResult | null {
		return this.lastTimeTravelDiff;
	}

	/**
	 * Runs a datalog query spec against the snapshot-built client (optionally
	 * at a transaction `tx` for time travel). Stores the result/error and
	 * notifies the query tab. Returns `null` when no snapshot is loaded or the
	 * query throws.
	 */
	runQuery(spec: QuerySpec, tx?: number): QueryTerm[][] | null {
		if (this.client === null) {
			this.lastQueryRows = null;
			this.lastQueryError = 'no snapshot loaded; nothing to query';
			this.notify('query');
			return null;
		}

		try {
			const rows = tx === undefined ? this.client.query(spec) : this.client.query(spec, tx);
			this.lastQuerySpec = spec;
			this.lastQueryRows = rows;
			this.lastQueryError = null;
			this.notify('query');
			return rows;
		} catch (error) {
			this.lastQueryRows = null;
			this.lastQueryError = error instanceof Error ? error.message : String(error);
			this.notify('query');
			return null;
		}
	}

	getLastQueryRows(): QueryTerm[][] | null {
		return this.lastQueryRows;
	}

	getLastQuerySpec(): QuerySpec | null {
		return this.lastQuerySpec;
	}

	getLastQueryError(): string | null {
		return this.lastQueryError;
	}

	setActiveTab(tab: DevtoolsTabId): void {
		this.activeTab = tab;
		this.notify(tab);
	}

	getActiveTab(): DevtoolsTabId {
		return this.activeTab;
	}

	/** Registers the re-render callback for a tab; called whenever that tab's state changes. */
	setRenderCallback(tab: DevtoolsTabId, callback: DevtoolsRenderCallback): void {
		this.renderCallbacks.set(tab, callback);
	}

	private notify(tab: DevtoolsTabId): void {
		this.renderCallbacks.get(tab)?.(this);
	}

	private notifyAll(): void {
		for (const tab of this.renderCallbacks.keys()) {
			this.notify(tab);
		}
	}
}
