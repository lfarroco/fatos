/**
 * React integration tests
 */

import { describe, it, expect } from 'vitest';
import {
	FatosProvider,
	createClient,
	useDatalogQuery,
	useEntity,
	useFatosClient,
	useQuery,
	useTransaction,
	version
} from './index';

describe('@fatos/react', () => {
	it('should export version', () => {
		expect(version).toBeDefined();
	});

	it('exports phase 2 react integration primitives', () => {
		expect(typeof createClient).toBe('function');
		expect(typeof FatosProvider).toBe('function');
		expect(typeof useFatosClient).toBe('function');
		expect(typeof useQuery).toBe('function');
		expect(typeof useDatalogQuery).toBe('function');
		expect(typeof useEntity).toBe('function');
		expect(typeof useTransaction).toBe('function');
	});
});
