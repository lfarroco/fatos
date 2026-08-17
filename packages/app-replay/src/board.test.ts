/**
 * Replay board logic — validates that the temporal primitives actually power
 * the app: at(tx) reads, diff-based undo, refs, and snapshot round-trips.
 */
import { describe, expect, it } from 'vitest';
import {
	addEdge,
	addNode,
	buildInverse,
	createBoard,
	deleteNode,
	exportSnapshot,
	headTx,
	importSnapshot,
	moveNode,
	readBoardAt,
	renameNode
} from './board';

describe('replay board', () => {
	it('rebuilds any past state with at(tx)', () => {
		const { db } = createBoard();
		const a = addNode(db, 10, 20);
		const b = addNode(db, 200, 300);
		const beforeMove = headTx(db);
		moveNode(db, a, 50, 60);

		const atEnd = readBoardAt(db, headTx(db));
		expect(atEnd.nodes.find((n) => n.id === a)).toMatchObject({ x: 50, y: 60 });

		const atBeforeMove = readBoardAt(db, beforeMove);
		expect(atBeforeMove.nodes.find((n) => n.id === a)).toMatchObject({ x: 10, y: 20 });
		expect(atBeforeMove.nodes).toHaveLength(2);
		expect(atEnd.nodes).toHaveLength(2);
		expect(b).toBeDefined();
	});

	it('stores edges as ref values and reads them back as ids', () => {
		const { db } = createBoard();
		const a = addNode(db, 0, 0);
		const b = addNode(db, 100, 100);
		addEdge(db, a, b);

		const { edges } = readBoardAt(db, headTx(db));
		expect(edges).toEqual([{ id: expect.any(String), from: a, to: b }]);
	});

	it('undo replays the inverse of a step and keeps history', () => {
		const { db } = createBoard();
		const a = addNode(db, 0, 0);
		const txAfterAdd = headTx(db);

		renameNode(db, a, 'Renamed');
		const diff = db.diff(txAfterAdd, headTx(db));
		expect(diff.added.length).toBe(1);
		expect(diff.retracted.length).toBe(1);

		db.transact(buildInverse(diff), { app: 'replay', action: 'undo' });
		const { nodes } = readBoardAt(db, headTx(db));
		expect(nodes.find((n) => n.id === a)?.label).toBe('Node');
		// History is preserved: undoing added transactions rather than erasing them.
		expect(headTx(db)).toBeGreaterThan(txAfterAdd + 1);
	});

	it('deleting a node also removes edges touching it', () => {
		const { db } = createBoard();
		const a = addNode(db, 0, 0);
		const b = addNode(db, 100, 100);
		addEdge(db, a, b);
		deleteNode(db, a);

		const { nodes, edges } = readBoardAt(db, headTx(db));
		expect(nodes.map((n) => n.id)).not.toContain(a);
		expect(edges).toHaveLength(0);
	});

	it('export/import round-trips the whole log', () => {
		const { db } = createBoard();
		const a = addNode(db, 10, 20);
		addEdge(db, a, addNode(db, 30, 40));
		const exported = exportSnapshot(db);

		const restored = importSnapshot(exported);
		expect(restored.db.getFacts()).toEqual(db.getFacts());
		expect(restored.db.getTransactions()).toEqual(db.getTransactions());
		expect(readBoardAt(restored.db, headTx(restored.db))).toEqual(readBoardAt(db, headTx(db)));
	});

	it('rejects invalid snapshots', () => {
		expect(() => importSnapshot('not json')).toThrow();
		expect(() => importSnapshot(JSON.stringify({ version: 99, facts: [], transactions: [] }))).toThrow();
	});
});
