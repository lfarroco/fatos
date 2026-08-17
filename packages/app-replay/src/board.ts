/**
 * Replay — pure board logic on top of the temporal fact store.
 *
 * This is the TIME-TRAVEL DEBUGGING niche probe. The whole point of the app is
 * that every user action is an append-only transaction, so the engine gives us
 * for free the things a "replay / undo / scrub" UI usually needs bespoke
 * engineering for:
 *
 * - `db.at(tx)` — reconstruct the board at any point in the session,
 * - `db.diff(txA, txB)` — what exactly changed in one step (the inverse is an
 *   undo that keeps history instead of erasing it),
 * - `ref()` — edges between node entities are real graph references,
 * - `db.set` — retract+add update helper for move/rename,
 * - snapshot export/import via the core wire tags.
 *
 * The db and client are created together so the React layer can use the
 * `FatosClient` surface (hooks, observers) while the app logic still reaches
 * the core `FactDatabase` methods (at/diff/set/restore).
 */
import { createClient, type FatosClient } from '@fatos/client';
import {
	createDatabase,
	deserializeValue,
	ref,
	serializeValue,
	type DiffResult,
	type EntityId,
	type Fact,
	type FactDatabase,
	type FactOperation,
	type Mutation,
	type TransactionRecord
} from '@fatos/core';

export type BoardDb = {
	db: FactDatabase;
	client: FatosClient;
};

export type BoardNode = {
	id: EntityId;
	label: string;
	x: number;
	y: number;
};

export type BoardEdge = {
	id: EntityId;
	from: EntityId;
	to: EntityId;
};

export type UserAction = {
	tx: number;
	label: string;
	inverse: Mutation[];
};

/** Creates a fresh board: schema declared as facts, then the client wrapping it. */
export function createBoard(): BoardDb {
	const db = createDatabase();
	db.transact([
		{ ident: 'node/label', valueType: 'string', cardinality: 'one' },
		{ ident: 'node/x', valueType: 'number', cardinality: 'one' },
		{ ident: 'node/y', valueType: 'number', cardinality: 'one' },
		{ ident: 'edge/from', valueType: 'ref', cardinality: 'one' },
		{ ident: 'edge/to', valueType: 'ref', cardinality: 'one' }
	]);
	return { db, client: createClient(db) };
}

/** The highest committed transaction id (0 when the log is empty). */
export function headTx(db: FactDatabase): number {
	const transactions = db.getTransactions();
	return transactions.length === 0 ? 0 : transactions[transactions.length - 1][0];
}

/**
 * Reads the board as of a transaction. `tx === head` reads the live database;
 * anything earlier goes through `db.at(tx)` — the temporal read primitive.
 * `ref()`-typed reads (`edge/from`, `edge/to`) come back as plain entity ids
 * by default (design/01), so no unwrapping is needed here.
 */
export function readBoardAt(db: FactDatabase, tx: number): { nodes: BoardNode[]; edges: BoardEdge[] } {
	const view = tx === headTx(db) ? db : db.at(tx);
	const nodeEntities = view.find({ 'node/label': { $exists: true } });
	const edgeEntities = view.find({ 'edge/from': { $exists: true } });

	const nodes: BoardNode[] = nodeEntities.map((entity) => ({
		id: entity.id,
		label: String(entity['node/label'] ?? ''),
		x: Number(entity['node/x'] ?? 0),
		y: Number(entity['node/y'] ?? 0)
	}));

	const edges: BoardEdge[] = [];
	for (const entity of edgeEntities) {
		const from = entity['edge/from'];
		const to = entity['edge/to'];
		if (isEntityId(from) && isEntityId(to)) {
			edges.push({ id: entity.id, from, to });
		}
	}

	return { nodes, edges };
}

function isEntityId(value: unknown): value is EntityId {
	return typeof value === 'number' || typeof value === 'string';
}

let actionSeq = 0;

/** Adds a node at (x, y); returns the new entity id. */
export function addNode(db: FactDatabase, x: number, y: number): EntityId {
	actionSeq += 1;
	const id = `node-${Date.now().toString(36)}-${actionSeq.toString(36)}`;
	db.transact(
		[
			['add', id, 'node/label', 'Node'],
			['add', id, 'node/x', x],
			['add', id, 'node/y', y]
		],
		{ app: 'replay', action: 'node:add' }
	);
	return id;
}

/** Moves a node — `db.set` computes the retract+add pair in one transaction. */
export function moveNode(db: FactDatabase, id: EntityId, x: number, y: number): void {
	db.set(id, { 'node/x': x, 'node/y': y });
}


/** Renames a node — same update path as move. */
export function renameNode(db: FactDatabase, id: EntityId, label: string): void {
	db.set(id, { 'node/label': label });
}

/** Connects two nodes with a directed edge stored as `ref()` facts. */
export function addEdge(db: FactDatabase, from: EntityId, to: EntityId): void {
	actionSeq += 1;
	const id = `edge-${Date.now().toString(36)}-${actionSeq.toString(36)}`;
	db.transact(
		[
			['add', id, 'edge/from', ref(from)],
			['add', id, 'edge/to', ref(to)]
		],
		{ app: 'replay', action: 'edge:add' }
	);
}

/** Deletes a node and any edge touching it (all retracts in one transaction). */
export function deleteNode(db: FactDatabase, id: EntityId): void {
	const entries: Mutation[] = [];
	for (const fact of db.getFactsByEntity(id)) {
		if (fact[4] === 'add') {
			entries.push(['retract', fact[0], fact[1], fact[2]]);
		}
	}

	for (const edge of db.find({ 'edge/from': { $exists: true } })) {
		const from = edge['edge/from'];
		const to = edge['edge/to'];
		if (from !== id && to !== id) {
			continue;
		}
		for (const fact of db.getFactsByEntity(edge.id)) {
			if (fact[4] === 'add') {
				entries.push(['retract', fact[0], fact[1], fact[2]]);
			}
		}
	}

	db.transact(entries, { app: 'replay', action: 'node:delete' });
}

/**
 * The inverse of a step: retract what was added, re-add what was retracted.
 * Applying it keeps the full history (a new tx sits on top) — a temporal undo.
 */
export function buildInverse(diff: DiffResult): Mutation[] {
	const inverse: Mutation[] = [];
	for (const fact of diff.added) {
		inverse.push(['retract', fact[0], fact[1], fact[2]]);
	}
	for (const fact of diff.retracted) {
		inverse.push(['add', fact[0], fact[1], fact[2]]);
	}
	return inverse;
}

export type BoardSnapshot = {
	version: 1;
	facts: unknown[][];
	transactions: TransactionRecord[];
};

/** Serializes the whole fact log to a JSON snapshot (values wire-tagged). */
export function exportSnapshot(db: FactDatabase): string {
	const payload: BoardSnapshot = {
		version: 1,
		facts: db.getFacts().map((fact) => [fact[0], fact[1], serializeValue(fact[2]), fact[3], fact[4]]),
		transactions: db.getTransactions().map(([tx, timestamp, metadata]) => [tx, timestamp, metadata])
	};
	return JSON.stringify(payload, null, 2);
}

/** Restores a board from a snapshot — a brand-new database + client. */
export function importSnapshot(text: string): BoardDb {
	let payload: BoardSnapshot;
	try {
		payload = JSON.parse(text) as BoardSnapshot;
	} catch {
		throw new Error('not valid JSON');
	}
	if (payload.version !== 1 || !Array.isArray(payload.facts) || !Array.isArray(payload.transactions)) {
		throw new Error('not a valid Fatos board snapshot');
	}

	const facts: Fact[] = payload.facts.map((entry) => {
		const [eid, attribute, value, tx, op] = entry as [EntityId, string, unknown, number, FactOperation];
		return [eid, attribute, deserializeValue(value), tx, op] as Fact;
	});

	const db = createDatabase();
	db.restore({ facts, transactions: payload.transactions });
	return { db, client: createClient(db) };
}
