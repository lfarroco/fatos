/**
 * Replay — a flow builder where every action is an append-only transaction.
 *
 * This is the TIME-TRAVEL DEBUGGING niche probe. The app itself is a toy
 * "visual editor", but the point is the substrate: undo, scrub, step-diff and
 * snapshot round-trips come from the fact log, not from bespoke state code.
 *
 * - Scrubber reads `readBoardAt(db, tx)` → `db.at(tx)` under the hood,
 * - "This step" renders `db.diff(tx - 1, tx)`,
 * - Undo applies the inverse of a step's diff (history is kept, not erased),
 * - Export/import round-trips the whole log through the core wire tags,
 * - `installSnapshotPublisher` bridges the board to the Fatos DevTools panel.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ChangeEvent, PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import { installSnapshotPublisher } from '@fatos/devtools';
import { serializeValue, type EntityId } from '@fatos/core';
import { FatosProvider, useTransaction } from '@fatos/react';
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
	renameNode,
	type BoardDb,
	type BoardNode,
	type UserAction
} from './board';

const CANVAS_W = 800;
const CANVAS_H = 560;
const NODE_W = 110;
const NODE_H = 52;

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function formatFactValue(value: unknown): string {
	try {
		return JSON.stringify(serializeValue(value));
	} catch {
		return String(value);
	}
}

function useClientTick(client: { subscribe(listener: () => void): () => void }): void {
	const [, setTick] = useState(0);
	useEffect(() => client.subscribe(() => setTick((tick) => tick + 1)), [client]);
}

function Board({ board, onReplace }: { board: BoardDb; onReplace: (next: BoardDb) => void }): ReactElement {
	const { db, client } = board;

	const [scrubTx, setScrubTx] = useState<number | null>(null);
	const [selected, setSelected] = useState<EntityId | null>(null);
	const [labelDraft, setLabelDraft] = useState('');
	const [undoStack, setUndoStack] = useState<UserAction[]>([]);
	const [message, setMessage] = useState('');
	const [drag, setDrag] = useState<{
		id: EntityId;
		rectLeft: number;
		rectTop: number;
		offsetX: number;
		offsetY: number;
	} | null>(null);
	const [preview, setPreview] = useState<{ x: number; y: number } | null>(null);
	const [fromId, setFromId] = useState<EntityId | null>(null);
	const [toId, setToId] = useState<EntityId | null>(null);

	useClientTick(client);
	const transactions = useTransaction();

	const head = headTx(db);
	const activeTx = scrubTx === null ? head : scrubTx;
	const atHead = activeTx === head;

	const { nodes, edges } = useMemo(() => readBoardAt(db, activeTx), [db, activeTx]);
	const diff = useMemo(
		() => (activeTx > 0 ? db.diff(activeTx - 1, activeTx) : { added: [], retracted: [] }),
		[db, activeTx]
	);
	const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);


	/** Runs a write inside the undo wrapper: diff the step, remember its inverse. */
	const apply = (perform: () => void, label: string): void => {
		const before = headTx(db);
		perform();
		const after = headTx(db);
		if (after === before) {
			return;
		}
		const step = db.diff(before, after);
		if (step.added.length === 0 && step.retracted.length === 0) {
			return;
		}
		setUndoStack((stack) => [...stack, { tx: after, label, inverse: buildInverse(step) }]);
		setScrubTx(null);
		setMessage(`${label} → tx ${after}`);
	};

	const handleAddNode = (): void => {
		const current = readBoardAt(db, headTx(db));
		const x = 60 + (current.nodes.length % 5) * 120;
		const y = 60 + Math.floor(current.nodes.length / 5) * 90;
		apply(() => addNode(db, x, y), 'add node');
	};

	const handleUndo = (): void => {
		const entry = undoStack[undoStack.length - 1];
		if (!entry) {
			return;
		}
		apply(() => db.transact(entry.inverse, { app: 'replay', action: 'undo' }), `undo ${entry.label}`);
		setUndoStack((stack) => stack.slice(0, -1));
	};

	const handleConnect = (): void => {
		if (fromId === null || toId === null || fromId === toId) {
			return;
		}
		apply(() => addEdge(db, fromId, toId), 'add edge');
	};

	const handleRename = (): void => {
		if (selected === null || labelDraft.trim() === '') {
			return;
		}
		apply(() => renameNode(db, selected, labelDraft.trim()), 'rename node');
	};

	const handleDelete = (): void => {
		if (selected === null) {
			return;
		}
		apply(() => deleteNode(db, selected), 'delete node');
		setSelected(null);
	};

	const handleSelectNode = (id: EntityId): void => {
		setSelected(id);
		const node = nodeById.get(id);
		setLabelDraft(node ? node.label : '');
	};

	const handleExport = (): void => {
		const json = exportSnapshot(db);
		const blob = new Blob([json], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = `replay-tx${headTx(db)}.json`;
		anchor.click();
		URL.revokeObjectURL(url);
		setMessage(`exported tx 1..${headTx(db)} (${db.getFacts().length} facts)`);
	};

	const handleImportFile = (event: ChangeEvent<HTMLInputElement>): void => {
		const file = event.target.files?.[0];
		if (!file) {
			return;
		}
		void file
			.text()
			.then((text) => {
				const next = importSnapshot(text);
				onReplace(next);
				setScrubTx(null);
				setSelected(null);
				setUndoStack([]);
				setMessage(`imported ${next.db.getFacts().length} facts / ${next.db.getTransactions().length} txs`);
			})
			.catch((error: unknown) => {
				setMessage(`import failed: ${error instanceof Error ? error.message : String(error)}`);
			});
	};

	const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>, node: BoardNode): void => {
		if (!atHead) {
			return;
		}
		event.preventDefault();
		const rect = event.currentTarget.getBoundingClientRect();
		setDrag({
			id: node.id,
			rectLeft: rect.left,
			rectTop: rect.top,
			offsetX: event.clientX - rect.left - node.x,
			offsetY: event.clientY - rect.top - node.y
		});
		setPreview({ x: node.x, y: node.y });
		event.currentTarget.setPointerCapture(event.pointerId);
	};

	const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
		if (drag === null) {
			return;
		}
		const x = clamp(event.clientX - drag.rectLeft - drag.offsetX, 0, CANVAS_W - NODE_W);
		const y = clamp(event.clientY - drag.rectTop - drag.offsetY, 0, CANVAS_H - NODE_H);
		setPreview({ x, y });
	};

	const handlePointerUp = (): void => {
		if (drag === null || preview === null) {
			return;
		}
		const id = drag.id;
		const { x, y } = preview;
		setDrag(null);
		setPreview(null);
		apply(() => moveNode(db, id, x, y), 'move node');
	};

	return (
		<>
			<div className="toolbar">
				<button className="primary" onClick={handleAddNode} disabled={!atHead}>
					+ Add node
				</button>
				<select
					value={fromId === null ? '' : String(fromId)}
					disabled={!atHead}
					onChange={(event) => setFromId(event.target.value === '' ? null : event.target.value)}
				>
					<option value="">from…</option>
					{nodes.map((node) => (
						<option key={String(node.id)} value={String(node.id)}>
							{node.label}
						</option>
					))}
				</select>
				<select
					value={toId === null ? '' : String(toId)}
					disabled={!atHead}
					onChange={(event) => setToId(event.target.value === '' ? null : event.target.value)}
				>
					<option value="">to…</option>
					{nodes.map((node) => (
						<option key={String(node.id)} value={String(node.id)}>
							{node.label}
						</option>
					))}
				</select>
				<button
					onClick={handleConnect}
					disabled={!atHead || fromId === null || toId === null || fromId === toId}
				>
					Connect
				</button>
				<input
					type="text"
					value={labelDraft}
					placeholder="rename…"
					disabled={selected === null || !atHead}
					onChange={(event) => setLabelDraft(event.target.value)}
				/>
				<button onClick={handleRename} disabled={selected === null || labelDraft.trim() === '' || !atHead}>
					Rename
				</button>
				<button onClick={handleDelete} disabled={selected === null || !atHead}>
					Delete
				</button>
				<button onClick={handleUndo} disabled={undoStack.length === 0}>
					Undo
				</button>
				<button onClick={handleExport}>Export</button>
				<label>
					Import
					<input
						type="file"
						accept="application/json"
						style={{ display: 'none' }}
						onChange={handleImportFile}
					/>
				</label>
				<span className="muted">selected: {selected === null ? 'none' : String(selected)}</span>
			</div>

			<div className="layout">
				<div
					className="canvas"
					onPointerMove={handlePointerMove}
					onPointerUp={handlePointerUp}
				>
					<svg className="edges">
						{edges.map((edge) => {
							const from = nodeById.get(edge.from);
							const to = nodeById.get(edge.to);
							if (from === undefined || to === undefined) {
								return null;
							}
							return (
								<line
									key={String(edge.id)}
									className="edge"
									x1={from.x + NODE_W / 2}
									y1={from.y + NODE_H / 2}
									x2={to.x + NODE_W / 2}
									y2={to.y + NODE_H / 2}
								/>
							);
						})}
					</svg>
					{nodes.map((node) => {
						const position = drag?.id === node.id && preview !== null ? preview : node;
						return (
							<div
								key={String(node.id)}
								className={`node${selected === node.id ? ' selected' : ''}${
									drag?.id === node.id ? ' dragging' : ''
								}${atHead ? '' : ' historical'}`}
								style={{ left: position.x, top: position.y }}
								onPointerDown={(event) => handlePointerDown(event, node)}
								onClick={() => handleSelectNode(node.id)}
							>
								{node.label}
							</div>
						);
					})}
					{!atHead ? <div className="scrub-overlay" /> : null}
				</div>

				<div className="sidebar">
					<section className="panel">
						<h2>Timeline</h2>
						<div className="scrubber">
							<input
								type="range"
								min={0}
								max={head}
								value={activeTx}
								onChange={(event) => setScrubTx(Number(event.target.value))}
							/>
							<button className="primary" disabled={atHead} onClick={() => setScrubTx(null)}>
								live
							</button>
						</div>
						<p className="muted">
							tx {activeTx} / {head}{' '}
							{atHead ? <span className="badge badge-live">live</span> : <span className="badge">as-of</span>}
						</p>
						{message !== '' ? <p className="message">{message}</p> : null}
					</section>

					<section className="panel">
						<h2>This step (diff)</h2>
						{activeTx === 0 ? (
							<p className="muted">No transactions yet.</p>
						) : (
							<ul className="diff">
								{diff.added.map((fact, index) => (
									<li key={`add-${index}`} className="add-fact">
										+ [{String(fact[0])} {fact[1]} = {formatFactValue(fact[2])}]
									</li>
								))}
								{diff.retracted.map((fact, index) => (
									<li key={`retract-${index}`} className="retract-fact">
										− [{String(fact[0])} {fact[1]} = {formatFactValue(fact[2])}]
									</li>
								))}
							</ul>
						)}
					</section>

					<section className="panel">
						<h2>History</h2>
						<p className="muted">{transactions.length} transactions in the log</p>
						<ul className="history">
							{undoStack.map((action) => (
								<li key={action.tx}>
									{action.label} <span className="muted">tx {action.tx}</span>
								</li>
							))}
						</ul>
					</section>
				</div>
			</div>
		</>
	);
}

export function App(): ReactElement {
	const [board, setBoard] = useState<BoardDb>(() => createBoard());

	useEffect(() => {
		const publisher = installSnapshotPublisher(board.client);
		return () => publisher.dispose();
	}, [board.client]);

	return (
		<FatosProvider client={board.client}>
			<div className="app">
				<header>
					<h1>Replay — flow builder with time travel</h1>
					<span className="subtitle">every action is a transaction · scrub · diff · undo · export/import</span>
				</header>
				<Board board={board} onReplace={setBoard} />
			</div>
		</FatosProvider>
	);
}

