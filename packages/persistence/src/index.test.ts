/**
 * Persistence layer tests — package exports and adapter contract surface.
 */

import { describe, it, expect } from 'vitest';
import {
	version,
	FileAdapter,
	IndexedDBAdapter,
	MemoryAdapter,
	MongoAdapter,
	PostgresAdapter
} from './index';

describe('@fatos/persistence', () => {
	it('should export version', () => {
		expect(version).toBeDefined();
	});

	it('exports every adapter with the StorageAdapter shape (load/save/close)', () => {
		const adapters: unknown[] = [
			new FileAdapter('/tmp/fatos-test.json'),
			new PostgresAdapter({ query: async () => ({ rows: [] }) }),
			new MongoAdapter({ findOne: async () => null, replaceOne: async () => undefined }),
			new IndexedDBAdapter(),
			new MemoryAdapter()
		];

		for (const adapter of adapters) {
			expect(typeof (adapter as { load: unknown }).load).toBe('function');
			expect(typeof (adapter as { save: unknown }).save).toBe('function');
			expect(typeof (adapter as { close: unknown }).close).toBe('function');
		}
	});
});

