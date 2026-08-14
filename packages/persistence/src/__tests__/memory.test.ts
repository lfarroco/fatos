/**
 * MemoryAdapter tests — round-trip must return identical facts/transactions.
 */

import { describe, it, expect } from 'vitest';
import { MemoryAdapter } from '../adapters/memory';
import { comparableFacts, makeRichSnapshot } from './fixtures';

describe('MemoryAdapter', () => {
	it('returns an empty snapshot before anything is saved', async () => {
		const adapter = new MemoryAdapter();
		await expect(adapter.load()).resolves.toEqual({ facts: [], transactions: [] });
	});

	it('round-trips a rich snapshot (write → load → identical)', async () => {
		const snapshot = makeRichSnapshot();
		const adapter = new MemoryAdapter();

		await adapter.save(snapshot);
		const loaded = await adapter.load();

		expect(comparableFacts(loaded.facts)).toEqual(comparableFacts(snapshot.facts));
		expect(loaded.transactions).toEqual(snapshot.transactions);
	});

	it('overwrites the previous snapshot on a second save', async () => {
		const adapter = new MemoryAdapter();
		await adapter.save(makeRichSnapshot());
		await adapter.save({ facts: [], transactions: [] });

		await expect(adapter.load()).resolves.toEqual({ facts: [], transactions: [] });
	});

	it('close() is a no-op and the adapter stays usable', async () => {
		const adapter = new MemoryAdapter();
		await adapter.save(makeRichSnapshot());
		await adapter.close();

		const loaded = await adapter.load();
		expect(loaded.facts.length).toBeGreaterThan(0);
	});
});
