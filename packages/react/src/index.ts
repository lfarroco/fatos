/**
 * @fatos/react - React integration
 * 
 * This module provides React hooks and integration for Fatos.
 * It includes:
 * - useQuery hook
 * - useEntity hook
 * - useTransaction hook
 * - Reactive query subscriptions
 */

import {
	createElement,
	createContext,
	type PropsWithChildren,
	useCallback,
	useContext,
	useSyncExternalStore
} from 'react';
import {
	createClient,
	type EntityState,
	type FatosClient,
	type QuerySpec,
	type QueryTerm,
	type TransactionRecord
} from '../../client/src/index';

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

export function useQuery(criteria: Record<string, unknown>): EntityState[] {
	const client = useFatosClient();
	const criteriaKey = JSON.stringify(criteria);
	const getSnapshot = useCallback(() => client.find(criteria), [client, criteriaKey]);

	return useSyncExternalStore(client.subscribe.bind(client), getSnapshot, getSnapshot);
}

export function useDatalogQuery(spec: QuerySpec): QueryTerm[][] {
	const client = useFatosClient();
	const specKey = JSON.stringify(spec);
	const getSnapshot = useCallback(() => client.query(spec), [client, specKey]);

	return useSyncExternalStore(client.subscribe.bind(client), getSnapshot, getSnapshot);
}

export function useEntity(eid: number): EntityState | null {
	const client = useFatosClient();
	const getSnapshot = useCallback(() => client.entity(eid), [client, eid]);

	return useSyncExternalStore(client.subscribe.bind(client), getSnapshot, getSnapshot);
}

export function useTransaction(): readonly TransactionRecord[] {
	const client = useFatosClient();
	const getSnapshot = useCallback(() => client.getTransactions(), [client]);

	return useSyncExternalStore(client.subscribe.bind(client), getSnapshot, getSnapshot);
}

export { createClient };
export type { EntityState, FatosClient, QuerySpec, QueryTerm, TransactionRecord };
