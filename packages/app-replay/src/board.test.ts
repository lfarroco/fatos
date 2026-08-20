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
		const board = createBoard();
		const a = addNode(board, 10, 20);
		const b = addNode(board, 200, 300);
		const beforeMove = headTx(board);
		moveNode(board, a, 50, 60);

		const atEnd = readBoardAt(board, headTx(board));
		expect(atEnd.nodes.find((n) => n.id === a)).toMatchObject({ x: 50, y: 60 });

		const atBeforeMove = readBoardAt(board, beforeMove);
		expect(atBeforeMove.nodes.find((n) => n.id === a)).toMatchObject({ x: 10, y: 20 });
		expect(atBeforeMove.nodes).toHaveLength(2);
		expect(atEnd.nodes).toHaveLength(2);
		expect(b).toBeDefined();
	});

	it('stores edges as ref values and reads them back as ids', () => {
		const board = createBoard();
		const a = addNode(board, 0, 0);
		const b = addNode(board, 100, 100);
		addEdge(board, a, b);

		const { edges } = readBoardAt(board, headTx(board));
		expect(edges).toEqual([{ id: expect.any(String), from: a, to: b }]);
	});

	it('undo replays the inverse of a step and keeps history', () => {
		const board = createBoard();
		const a = addNode(board, 0, 0);
		const txAfterAdd = headTx(board);

		renameNode(board, a, 'Renamed');
		const diff = board.diff(txAfterAdd, headTx(board));
		expect(diff.added.length).toBe(1);
		expect(diff.retracted.length).toBe(1);

		board.transact(buildInverse(diff), { app: 'replay', action: 'undo' });
		const { nodes } = readBoardAt(board, headTx(board));
		expect(nodes.find((n) => n.id === a)?.label).toBe('Node');
		// History is preserved: undoing added transactions rather than erasing them.
		expect(headTx(board)).toBeGreaterThan(txAfterAdd + 1);
	});

	it('deleting a node also removes edges touching it', () => {
		const board = createBoard();
		const a = addNode(board, 0, 0);
		const b = addNode(board, 100, 100);
		addEdge(board, a, b);
		deleteNode(board, a);

		const { nodes, edges } = readBoardAt(board, headTx(board));
		expect(nodes.map((n) => n.id)).not.toContain(a);
		expect(edges).toHaveLength(0);
	});

	it('export/import round-trips the whole log', () => {
		const board = createBoard();
		const a = addNode(board, 10, 20);
		addEdge(board, a, addNode(board, 30, 40));
		const exported = exportSnapshot(board);

		const restored = importSnapshot(exported);
		expect(restored.getFacts()).toEqual(board.getFacts());
		expect(restored.getTransactions()).toEqual(board.getTransactions());
		expect(readBoardAt(restored, headTx(restored))).toEqual(readBoardAt(board, headTx(board)));
	});

	it('rejects invalid snapshots', () => {
		expect(() => importSnapshot('not json')).toThrow();
		expect(() => importSnapshot(JSON.stringify({ version: 99, facts: [], transactions: [] }))).toThrow();
	});
});

