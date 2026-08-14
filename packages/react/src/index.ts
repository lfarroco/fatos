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
	useSyncExternalStore
} from 'react';
import {
	createClient,
	type EntityId,
	type EntityState,
	type FatosClient,
	type LiveResult,
	type QuerySpec,
	type QueryTerm,
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
export function useQuery(criteria: Record<string, unknown>): EntityState[];
export function useQuery<T>(
	input: ((db: FatosClient) => T) | Record<string, unknown>
): T | EntityState[] {
	if (typeof input === 'function') {
		return useQuerySelector(input);
	}

	return useQueryCriteria(input);
}

function useQuerySelector<T>(selector: (db: FatosClient) => T): T {
	const client = useFatosClient();

	// Hold the latest selector so inline closures see fresh props, while the
	// live handle itself is created once per mount — otherwise a new inline
	// selector identity per render would recreate the handle and defeat the
	// memoized-snapshot bail-out. The core `live(fn)` form calls `fn` without
	// arguments, so the hook supplies the client from context itself.
	const selectorRef = useRef(selector);
	selectorRef.current = selector;

	return useLiveValue([], () => client.live(() => selectorRef.current(client)));
}

function useQueryCriteria(criteria: Record<string, unknown>): EntityState[] {
	const client = useFatosClient();
	const criteriaKey = JSON.stringify(criteria);

	return useLiveValue([criteriaKey], () => client.live(criteria));
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

export { createClient };
export type { EntityId, EntityState, FatosClient, QuerySpec, QueryTerm, TransactionRecord };
