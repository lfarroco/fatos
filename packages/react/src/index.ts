/**
 * @fatos/react - React integration
 * 
 * This module provides React hooks and integration for Fatos.
 * It includes:
 * - useQuery hook (selector and criteria forms)
 * - useDatalogQuery hook
 * - useEntity hook
 * - useTransaction hook
 * - Reactive query subscriptions with memoized snapshots
 */

import {
	createElement,
	createContext,
	type PropsWithChildren,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore
} from 'react';
import {
	createClient,
	createSyncingClient,
	type EntityId,
	type EntityState,
	type FatosClient,
	type FindOptions,
	type LiveResult,
	type QuerySpec,
	type QueryTerm,
	type SyncStatus,
	type SyncingClient,
	type SyncingClientOptions,
	type TransactionRecord
} from '@fatos/client';

export const version = '0.0.1';

const FatosClientContext = createContext<FatosClient | null>(null);

export type FatosProviderProps = PropsWithChildren<{
	client: FatosClient;
}>;

export function FatosProvider({ client, children }: FatosProviderProps) {
	return createElement(FatosClientContext.Provider, { value: client }, children);
}

export function useFatosClient(): FatosClient {
	const client = useContext(FatosClientContext);
	if (!client) {
		throw new Error('useFatosClient must be used within FatosProvider');
	}

	return client;
}

/**
 * Creates a {@link SyncingClient} for `url` and mirrors its lifecycle into
 * React state: the local mirror `client`, the `sync` handle (write-through
 * `transact` / `insert` / `set` / `merge`), the connection `status`, and the
 * latest `error`. `start()` is called on mount, `stop()` on unmount.
 *
 * The `options` are kept on a ref so an inline object per render never
 * recreates the connection; only `url` changes re-sync. Status/error/client
 * callbacks are owned by the hook.
 */
export function useSyncedClient(
	url: string,
	options?: Omit<SyncingClientOptions, 'url' | 'onStatusChange' | 'onError' | 'onClientReplaced'>
): {
	client: FatosClient | null;
	sync: SyncingClient | null;
	status: SyncStatus;
	error: Error | null;
} {
	const [client, setClient] = useState<FatosClient | null>(null);
	const [sync, setSync] = useState<SyncingClient | null>(null);
	const [status, setStatus] = useState<SyncStatus>('idle');
	const [error, setError] = useState<Error | null>(null);

	const optionsRef = useRef(options);
	optionsRef.current = options;

	useEffect(() => {
		const syncing = createSyncingClient({
			url,
			...optionsRef.current,
			onStatusChange: (next) => setStatus(next),
			onError: (next) => setError(next),
			onClientReplaced: (next) => setClient(next)
		});
		setClient(syncing.client);
		setSync(syncing);
		syncing.start();
		return () => syncing.stop();
	}, [url]);

	return { client, sync, status, error };
}

/**
 * Core subscription primitive shared by every data hook (design/03): creates
 * one live handle per query key and exposes the handle's memoized `current`
 * value as the external-store snapshot. The core live machinery re-evaluates
 * only on relevant writes and keeps the previous snapshot identity when the
 * result is unchanged, so `useSyncExternalStore` bails out on unrelated
 * writes.
 */
function useLiveValue<T>(deps: readonly unknown[], createLive: () => LiveResult<T>): T {
	const client = useFatosClient();

	const live = useMemo(() => createLive(), [client, ...deps]);

	useEffect(() => {
		return () => {
			live.dispose();
		};
	}, [live]);

	const subscribe = useCallback(
		(onStoreChange: () => void) =>
			live.subscribe(() => {
				onStoreChange();
			}),
		[live]
	);

	const getSnapshot = useCallback(() => live.current, [live]);

	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useQuery<T>(selector: (db: FatosClient) => T): T;
export function useQuery(criteria: Record<string, unknown>, options?: FindOptions): EntityState[];
export function useQuery<T>(
	input: ((db: FatosClient) => T) | Record<string, unknown>,
	options?: FindOptions
): T | EntityState[] {
	if (typeof input === 'function') {
		return useQuerySelector(input);
	}

	return useQueryCriteria(input, options);
}

function useQuerySelector<T>(selector: (db: FatosClient) => T): T {
	const client = useFatosClient();

	// Hold the latest selector so inline closures see fresh props, while the
	// live handle itself is created once per mount — otherwise a new inline
	// selector identity per render would recreate the handle and defeat the
	// memoized-snapshot bail-out. `client.live(fn)` already supplies the
	// client as the selector's first argument, so the ref-indirected closure
	// can simply forward it.
	const selectorRef = useRef(selector);
	selectorRef.current = selector;

	return useLiveValue([], () => client.live(() => selectorRef.current(client)));
}

function useQueryCriteria(criteria: Record<string, unknown>, options?: FindOptions): EntityState[] {
	const client = useFatosClient();
	const criteriaKey = JSON.stringify(criteria);
	const optionsKey = JSON.stringify(options ?? null);

	// The criteria-form `client.live(criteria)` cannot carry options, so use
	// the access-tracking selector form: `find` records the criteria
	// attributes and the orderBy/select reads happen through the tracked
	// entity proxies, keeping the AEVT-narrowed live dependencies intact
	// (a write to a sort key still wakes the handle).
	return useLiveValue([criteriaKey, optionsKey], () => client.live(() => client.find(criteria, options)));
}

export function useDatalogQuery(spec: QuerySpec): QueryTerm[][] {
	const client = useFatosClient();
	const specKey = JSON.stringify(spec);

	return useLiveValue([specKey], () => client.live(spec));
}

export function useEntity(eid: EntityId): EntityState | null {
	const client = useFatosClient();
	const entityKey = String(eid);

	return useLiveValue([entityKey], () => client.live(() => client.entity(eid)));
}

export function useTransaction(): readonly TransactionRecord[] {
	const client = useFatosClient();

	return useLiveValue([], () => client.live(() => client.getTransactions()));
}

export { createClient, createSyncingClient };
export type {
	EntityId,
	EntityState,
	FatosClient,
	FindOptions,
	QuerySpec,
	QueryTerm,
	SyncStatus,
	SyncingClient,
	SyncingClientOptions,
	TransactionRecord
};
