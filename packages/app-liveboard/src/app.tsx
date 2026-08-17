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
import { useEffect, useState } from 'react';
import type { DragEvent as ReactDragEvent, ReactElement } from 'react';
import {
	createSyncingClient,
	type EntityState,
	type FatosClient,
	type SyncStatus
} from '@fatos/client';
import { FatosProvider, useFatosClient, useQuery, useTransaction } from '@fatos/react';
import { apiBase, postTransact } from './api';

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

function useSyncedClient(url: string): { client: FatosClient | null; status: SyncStatus; error: Error | null } {
	const [client, setClient] = useState<FatosClient | null>(null);
	const [status, setStatus] = useState<SyncStatus>('idle');
	const [error, setError] = useState<Error | null>(null);

	useEffect(() => {
		const sync = createSyncingClient({
			url,
			onStatusChange: (next) => setStatus(next),
			onError: (next) => setError(next),
			onClientReplaced: (next) => setClient(next)
		});
		setClient(sync.client);
		sync.start();
		return () => sync.stop();
	}, [url]);

	return { client, status, error };
}

function reportError(error: unknown): void {
	console.error('[liveboard] write failed', error);
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
	baseUrl,
	cards
}: {
	column: { id: string; label: string };
	baseUrl: string;
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

		const order = cards.length;
		const entries: unknown[] = [];
		if (card['card/column'] !== column.id) {
			entries.push(['retract', id, 'card/column', card['card/column']]);
			entries.push(['add', id, 'card/column', column.id]);
		}
		if (card['card/order'] !== order) {
			entries.push(['retract', id, 'card/order', card['card/order']]);
			entries.push(['add', id, 'card/order', order]);
		}
		if (entries.length === 0) {
			return;
		}
		void postTransact(baseUrl, entries, { actor: 'liveboard-user', action: 'card:move', toColumn: column.id }).catch(
			reportError
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

function AddCard({ baseUrl }: { baseUrl: string }): ReactElement {
	const [title, setTitle] = useState('');

	const handleAddCard = (): void => {
		const trimmed = title.trim();
		if (trimmed === '') {
			return;
		}
		const id = `card-${Date.now().toString(36)}`;
		void postTransact(
			baseUrl,
			[
				['add', id, 'card/title', trimmed],
				['add', id, 'card/column', 'todo'],
				['add', id, 'card/order', 0]
			],
			{ actor: 'liveboard-user', action: 'card:add' }
		).catch(reportError);
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
	baseUrl
}: {
	column: { id: string; label: string };
	baseUrl: string;
}): ReactElement {
	// One live query per column — a write touching only `card/column` wakes
	// the column queries, and the memoized snapshot bails out when the result
	// is unchanged. Ordering comes from `find`'s `orderBy`, not a JS sort.
	const cards = useQuery({ 'card/column': column.id }, { orderBy: ['card/order', 'asc'] });
	return <Column column={column} baseUrl={baseUrl} cards={cards} />;
}

function Board({ baseUrl }: { baseUrl: string }): ReactElement {
	return (
		<>
			<AddCard baseUrl={baseUrl} />
			<div className="board">
				{COLUMNS.map((column) => (
					<ColumnContainer key={column.id} column={column} baseUrl={baseUrl} />
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

function Shell({ baseUrl, status, error }: { baseUrl: string; status: SyncStatus; error: Error | null }): ReactElement {
	return (
		<main className="app">
			<header>
				<h1>LiveBoard</h1>
				<span className={`status status-${status}`}>{status}</span>
				<span className="subtitle">
					multi-client kanban · {baseUrl} · open this page in two tabs and drag cards
				</span>
			</header>
			{error !== null ? <p className="error">sync error: {error.message}</p> : null}
			<Board baseUrl={baseUrl} />
			<ActivityLog />
		</main>
	);
}

export function App(): ReactElement {
	const [url] = useState<string>(() => defaultServerUrl());
	const { client, status, error } = useSyncedClient(url);

	if (client === null) {
		return <p className="app">Connecting to {url}…</p>;
	}

	return (
		<FatosProvider client={client}>
			<Shell baseUrl={apiBase(url)} status={status} error={error} />
		</FatosProvider>
	);
}

