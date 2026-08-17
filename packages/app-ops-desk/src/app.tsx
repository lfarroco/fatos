/**
 * Ops Desk — an order-fulfillment + inventory tracker.
 *
 * This app probes the AUDIT / OPERATIONS niche. Everything the "ops" user
 * cares about is free because the data model is temporal:
 *
 * - every stock adjustment and status transition is one transaction carrying
 *   `{ actor, action, ... }` metadata → the audit log is the transaction log,
 * - `client.find(criteria, tx)` answers "what was the state at tx N",
 * - live queries push only the panels that actually changed,
 * - two browser windows over one server both stay in sync via WebSocket.
 *
 * Writes are write-through (`sync.transact`); the server's broadcast then
 * reaches every tab's mirror over the same sync socket.
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import {
	createSyncingClient,
	type EntityId,
	type EntityState,
	type FatosClient,
	type SyncStatus,
	type SyncingClient
} from '@fatos/client';
import { FatosProvider, useFatosClient, useQuery, useTransaction } from '@fatos/react';

const DEFAULT_WS_URL = 'ws://localhost:4100/ws';

const STATUS_FLOW: Record<string, string> = {
	placed: 'picked',
	picked: 'shipped',
	shipped: 'delivered'
};

function defaultServerUrl(): string {
	const params = new URLSearchParams(window.location.search);
	return params.get('server') ?? DEFAULT_WS_URL;
}

function useClientTick(client: FatosClient | null): void {
	const [, setTick] = useState(0);
	useEffect(() => {
		if (!client) {
			return;
		}
		return client.subscribe(() => setTick((tick) => tick + 1));
	}, [client]);
}

function useSyncedClient(url: string): {
	client: FatosClient | null;
	sync: SyncingClient | null;
	status: SyncStatus;
	error: Error | null;
} {
	const [client, setClient] = useState<FatosClient | null>(null);
	const [sync, setSync] = useState<SyncingClient | null>(null);
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
		setSync(sync);
		sync.start();
		return () => sync.stop();
	}, [url]);

	return { client, sync, status, error };
}

function sortBy(items: EntityState[], key: string): EntityState[] {
	return [...items].sort((left, right) => String(left[key] ?? '').localeCompare(String(right[key] ?? '')));
}

function InventoryPanel({ sync }: { sync: SyncingClient }): ReactElement {
	const client = useFatosClient();
	const items = useQuery((db) => sortBy(db.find({ 'item/sku': { $exists: true } }), 'item/sku'));

	const adjust = (eid: EntityId, delta: number): void => {
		const current = client.entity(eid)?.['item/stock'];
		if (typeof current !== 'number') {
			return;
		}
		void sync.transact(
			[
				['retract', eid, 'item/stock', current],
				['add', eid, 'item/stock', current + delta]
			],
			{ actor: 'ops-desk-user', action: 'adjust-stock', delta }
		);
	};

	return (
		<section className="panel">
			<h2>Inventory</h2>
			<p className="muted">Live stock — every +/− is a transaction with an actor in the audit trail.</p>
			<table>
				<thead>
					<tr>
						<th>SKU</th>
						<th>Name</th>
						<th>Stock</th>
						<th>Adjust</th>
					</tr>
				</thead>
				<tbody>
					{items.map((item) => (
						<tr key={String(item.id)}>
							<td>{String(item['item/sku'])}</td>
							<td>{String(item['item/name'] ?? '')}</td>
							<td>{String(item['item/stock'] ?? '')}</td>
							<td>
								<span className="stock-cell">
									<button onClick={() => adjust(item.id, -1)}>−1</button>
									<button onClick={() => adjust(item.id, 1)}>+1</button>
								</span>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</section>
	);
}

function OrdersPanel({ sync }: { sync: SyncingClient }): ReactElement {
	const orders = useQuery((db) => sortBy(db.find({ 'order/status': { $exists: true } }), 'order/number'));

	const advance = (order: EntityState): void => {
		const current = String(order['order/status'] ?? '');
		const next = STATUS_FLOW[current];
		if (!next) {
			return;
		}
		void sync.transact(
			[
				['retract', order.id, 'order/status', current],
				['add', order.id, 'order/status', next]
			],
			{ actor: 'ops-desk-user', action: 'order:transition', from: current, to: next }
		);
	};

	return (
		<section className="panel">
			<h2>Orders</h2>
			<p className="muted">Status transitions write a retract+add pair — the history is never lost.</p>
			<table>
				<thead>
					<tr>
						<th>Order</th>
						<th>Item</th>
						<th>Customer</th>
						<th>Status</th>
						<th />
					</tr>
				</thead>
				<tbody>
					{orders.map((order) => {
						const status = String(order['order/status'] ?? '');
						const next = STATUS_FLOW[status];
						return (
							<tr key={String(order.id)}>
								<td>{String(order['order/number'])}</td>
								<td>{String(order['order/item'] ?? '')}</td>
								<td>{String(order['order/customer'] ?? '')}</td>
								<td>
									<span className={`badge badge-${status}`}>{status}</span>
								</td>
								<td>
									<button className="primary" disabled={!next} onClick={() => advance(order)}>
										{next ? `→ ${next}` : 'done'}
									</button>
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
			{orders.length === 0 ? <p className="empty">No orders yet.</p> : null}
		</section>
	);
}

function formatMetadata(metadata: Record<string, unknown> | null): string {
	return metadata === null ? '—' : JSON.stringify(metadata);
}

function AuditPanel(): ReactElement {
	const transactions = useTransaction();
	const recent = [...transactions].slice(-12).reverse();

	return (
		<section className="panel">
			<h2>Audit trail</h2>
			<p className="muted">
				{transactions.length} transactions — the ledger IS the audit log (actor + action in metadata).
			</p>
			<ul className="timeline">
				{recent.map((tx) => (
					<li key={tx[0]}>
						<strong>tx {tx[0]}</strong> <span className="muted">{new Date(tx[1]).toLocaleTimeString()}</span>
						<br />
						<span className="muted">{formatMetadata(tx[2])}</span>
					</li>
				))}
			</ul>
		</section>
	);
}

function formatValue(value: unknown): string {
	if (typeof value === 'object' && value !== null) {
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}
	return String(value);
}

function TimeTravelPanel(): ReactElement {
	const client = useFatosClient();
	const transactions = useTransaction();
	const headTx = transactions.length === 0 ? 0 : transactions[transactions.length - 1][0];
	const [tx, setTx] = useState<number>(headTx);
	useClientTick(client);

	useEffect(() => {
		setTx((current) => Math.min(current, headTx));
	}, [headTx]);

	const atHead = tx >= headTx;
	const items = sortBy(client.find({ 'item/sku': { $exists: true } }, tx), 'item/sku');
	const orders = sortBy(client.find({ 'order/status': { $exists: true } }, tx), 'order/number');
	const txFacts = tx > 0 ? client.getFacts().filter((fact) => fact[3] === tx) : [];
	const added = txFacts.filter((fact) => fact[4] === 'add');
	const retracted = txFacts.filter((fact) => fact[4] === 'retract');

	return (
		<section className="panel">
			<h2>Time travel</h2>
			<p className="muted">Scrub back — reads run at client.find(criteria, tx), so the UI is exactly the state at tx.</p>
			<div className="scrubber">
				<input
					type="range"
					min={0}
					max={headTx}
					value={tx}
					onChange={(event) => setTx(Number(event.target.value))}
				/>
				<button disabled={atHead} onClick={() => setTx(headTx)}>
					live
				</button>
			</div>
			<p className="muted">
				State at <strong>tx {tx}</strong> / {headTx} {atHead ? '(live)' : '(as-of)'}
			</p>
			<table>
				<thead>
					<tr>
						<th>SKU</th>
						<th>Stock</th>
						<th>Orders</th>
					</tr>
				</thead>
				<tbody>
					{items.map((item) => (
						<tr key={String(item.id)}>
							<td>{String(item['item/sku'])}</td>
							<td>{String(item['item/stock'] ?? '')}</td>
							<td />
						</tr>
					))}
					{orders.map((order) => (
						<tr key={String(order.id)}>
							<td>{String(order['order/number'])}</td>
							<td>{String(order['order/status'] ?? '')}</td>
							<td />
						</tr>
					))}
				</tbody>
			</table>
			{txFacts.length > 0 ? (
				<>
					<p className="muted">Facts committed in tx {tx} (diff vs tx {Math.max(0, tx - 1)}):</p>
					<ul className="timeline">
						{added.map((fact, index) => (
							<li key={`add-${index}`} className="facts add-fact">
								+ [{String(fact[0])} {fact[1]} = {formatValue(fact[2])}]
							</li>
						))}
						{retracted.map((fact, index) => (
							<li key={`retract-${index}`} className="facts retract-fact">
								− [{String(fact[0])} {fact[1]} = {formatValue(fact[2])}]
							</li>
						))}
					</ul>
				</>
			) : null}
		</section>
	);
}

function Shell({ sync, status, error }: { sync: SyncingClient; status: SyncStatus; error: Error | null }): ReactElement {
	return (
		<main className="app">
			<header>
				<h1>Ops Desk</h1>
				<span className={`status status-${status}`}>{status}</span>
				<span className="subtitle">fulfillment + inventory · {sync.httpBaseUrl}</span>
			</header>
			{error !== null ? <p className="error">sync error: {error.message}</p> : null}
			<div className="grid">
				<InventoryPanel sync={sync} />
				<OrdersPanel sync={sync} />
			</div>
			<div className="grid">
				<AuditPanel />
				<TimeTravelPanel />
			</div>
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

