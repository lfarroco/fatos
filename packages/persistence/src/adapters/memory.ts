/**
 * In-memory adapter — useful for tests and as a default in code paths that
 * require a `StorageAdapter`. Data lives for the lifetime of the adapter
 * instance; nothing is durable across processes.
 *
 * Engine values are stored natively (no wire serialization), so Date, bigint,
 * and ref values keep their exact identity. `load()` returns fresh arrays
 * (the fact/transaction tuples themselves are shared — the engine treats them
 * as immutable).
 *
 * `append()` records a committed transaction in memory the same way `save()`
 * does, so the adapter instance stays the source of truth between saves.
 */

import type { Fact, TransactionRecord } from '@fatos/core';
import type { DatabaseSnapshot, StorageAdapter } from '../types';

export class MemoryAdapter implements StorageAdapter {
	private facts: Fact[] = [];
	private transactions: TransactionRecord[] = [];

	load(): Promise<DatabaseSnapshot> {
		return Promise.resolve({ facts: this.facts.slice(), transactions: this.transactions.slice() });
	}

	save(snapshot: DatabaseSnapshot): Promise<void> {
		this.facts = snapshot.facts.slice();
		this.transactions = snapshot.transactions.slice();
		return Promise.resolve();
	}

	append(transaction: TransactionRecord, facts: readonly Fact[]): Promise<void> {
		this.transactions.push(transaction);
		for (const fact of facts) {
			this.facts.push(fact);
		}
		return Promise.resolve();
	}

	close(): Promise<void> {
		return Promise.resolve();
	}
}
