/**
 * LiveBoard — a collaborative kanban board.
 *
 * This app probes the REALTIME COLLABORATION niche. It is deliberately the
 * weakest fit of the three (any realtime DB could power it) — the question is
 * what the temporal core adds: full activity history, "as of" debugging, and
 * the fact that "board state" is just a projection of a queryable log.
 *
 * Open the same page in two tabs: both sync over the Fatos server's WebSocket,
 * and each column subscribes to its own slice (`card/column`), so a move only
 * wakes the columns that actually changed.
 */
import { useState } from 'react';
import type { DragEvent as ReactDragEvent, ReactElement } from 'react';
import { type EntityState, type SyncStatus, type SyncingClient } from '@fatos/client';
import {
	FatosProvider,
	useFatosClient,
	useQuery,
	useSyncedClient,
	useTransaction
} from '@fatos/react';

const DEFAULT_WS_URL = 'ws://localhost:4200/ws';

const COLUMNS: Array<{ id: string; label: string }> = [
	{ id: 'todo', label: 'To Do' },
	{ id: 'in-progress', label: 'In Progress' },
	{ id: 'done', label: 'Done' }
];

function defaultServerUrl(): string {
	const params = new URLSearchParams(window.location.search);
	return params.get('server') ?? DEFAULT_WS_URL;
}

function Card({ card }: { card: EntityState }): ReactElement {
	const [dragging, setDragging] = useState(false);

	const handleDragStart = (event: ReactDragEvent<HTMLDivElement>): void => {
		event.dataTransfer.setData('text/plain', String(card.id));
		event.dataTransfer.effectAllowed = 'move';
		setDragging(true);
	};

	const handleDragEnd = (): void => {
		setDragging(false);
	};

	return (
		<div
			className={`card${dragging ? ' dragging' : ''}`}
			draggable
			onDragStart={handleDragStart}
			onDragEnd={handleDragEnd}
		>
			{String(card['card/title'] ?? '')}
			<div className="meta">
				{String(card.id)} · #{String(card['card/order'] ?? '')}
			</div>
		</div>
	);
}

function Column({
	column,
	sync,
	cards
}: {
	column: { id: string; label: string };
	sync: SyncingClient;
	cards: EntityState[];
}): ReactElement {
	const client = useFatosClient();
	const [dragOver, setDragOver] = useState(false);

	const handleDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
		event.preventDefault();
		setDragOver(false);
		const id = event.dataTransfer.getData('text/plain');
		if (id === '') {
			return;
		}
		const card = client.entity(id);
		if (!card) {
			return;
		}

		// `sync.set` diffs against the mirror: unchanged attributes are not
		// written, so a drop that moves nothing POSTs nothing.
		const order = cards.length;
		void sync.set(
			id,
			{ 'card/column': column.id, 'card/order': order },
			{ actor: 'liveboard-user', action: 'card:move', toColumn: column.id }
		);
	};

	return (
		<div
			className={`column${dragOver ? ' drag-over' : ''}`}
			onDragOver={(event) => {
				event.preventDefault();
				event.dataTransfer.dropEffect = 'move';
			}}
			onDragEnter={() => setDragOver(true)}
			onDragLeave={() => setDragOver(false)}
			onDrop={handleDrop}
		>
			<h2>
				{column.label} ({cards.length})
			</h2>
			{cards.map((card) => (
				<Card key={String(card.id)} card={card} />
			))}
		</div>
	);
}

function AddCard({ sync }: { sync: SyncingClient }): ReactElement {
	const [title, setTitle] = useState('');

	const handleAddCard = (): void => {
		const trimmed = title.trim();
		if (trimmed === '') {
			return;
		}
		const id = `card-${Date.now().toString(36)}`;
		void sync.insert(
			{ id, 'card/title': trimmed, 'card/column': 'todo', 'card/order': 0 },
			{ actor: 'liveboard-user', action: 'card:add' }
		);
		setTitle('');
	};

	return (
		<div className="add-card">
			<input
				type="text"
				value={title}
				placeholder="New card title…"
				onChange={(event) => setTitle(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === 'Enter') {
						handleAddCard();
					}
				}}
			/>
			<button className="primary" disabled={title.trim() === ''} onClick={handleAddCard}>
				Add card
			</button>
		</div>
	);
}

function ColumnContainer({
	column,
	sync
}: {
	column: { id: string; label: string };
	sync: SyncingClient;
}): ReactElement {
	// One live query per column — a write touching only `card/column` wakes
	// the column queries, and the memoized snapshot bails out when the result
	// is unchanged. Ordering comes from `find`'s `orderBy`, not a JS sort.
	const cards = useQuery({ 'card/column': column.id }, { orderBy: ['card/order', 'asc'] });
	return <Column column={column} sync={sync} cards={cards} />;
}

function Board({ sync }: { sync: SyncingClient }): ReactElement {
	return (
		<>
			<AddCard sync={sync} />
			<div className="board">
				{COLUMNS.map((column) => (
					<ColumnContainer key={column.id} column={column} sync={sync} />
				))}
			</div>
		</>
	);
}


function ActivityLog(): ReactElement {
	const transactions = useTransaction();
	const recent = [...transactions].slice(-10).reverse();
	return (
		<section className="panel">
			<h2>Transaction log</h2>
			<p className="muted">{transactions.length} transactions — every drag, every add.</p>
			<ul className="activity">
				{recent.map((tx) => {
					const metadata = tx[2];
					const action = metadata !== null ? String(metadata['action'] ?? '') : '';
					const actor = metadata !== null ? String(metadata['actor'] ?? '') : '';
					return (
						<li key={tx[0]}>
							tx {tx[0]} · <strong>{action || 'write'}</strong>
							{actor !== '' ? ` by ${actor}` : ''}
						</li>
					);
				})}
			</ul>
		</section>
	);
}

function Shell({ sync, status, error }: { sync: SyncingClient; status: SyncStatus; error: Error | null }): ReactElement {
	return (
		<main className="app">
			<header>
				<h1>LiveBoard</h1>
				<span className={`status status-${status}`}>{status}</span>
				<span className="subtitle">
					multi-client kanban · {sync.httpBaseUrl} · open this page in two tabs and drag cards
				</span>
			</header>
			{error !== null ? <p className="error">sync error: {error.message}</p> : null}
			<Board sync={sync} />
			<ActivityLog />
		</main>
	);
}

export function App(): ReactElement {
	const [url] = useState<string>(() => defaultServerUrl());
	const { client, sync, status, error } = useSyncedClient(url);

	if (client === null || sync === null) {
		return <p className="app">Connecting to {url}…</p>;
	}

	return (
		<FatosProvider client={client}>
			<Shell sync={sync} status={status} error={error} />
		</FatosProvider>
	);
}

