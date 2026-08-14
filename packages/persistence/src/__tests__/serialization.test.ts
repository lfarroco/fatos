/**
 * Snapshot serialization tests — the wire-tagged JSON form shared by the
 * durable adapters must round-trip Date / bigint / ref / array values (and
 * typed transaction metadata) losslessly, and reject malformed payloads with
 * clear errors.
 */

import { describe, expect, it } from 'vitest';
import { createDatabase } from '@fatos/core';
import { deserializeSnapshot, serializeSnapshot } from '../serialization';
import { comparableFacts, makeRichSnapshot } from './fixtures';

describe('snapshot serialization', () => {
	it('round-trips a rich snapshot through the core wire tags', () => {
		const snapshot = makeRichSnapshot();
		const json = serializeSnapshot(snapshot);

		// The payload is plain JSON: wire tags, no engine values leaked.
		const wire = JSON.parse(JSON.stringify(json)) as unknown;
		expect(wire).toEqual(json);

		const loaded = deserializeSnapshot(json);

		expect(comparableFacts(loaded.facts)).toEqual(comparableFacts(snapshot.facts));
		expect(loaded.transactions).toEqual(snapshot.transactions);

		// Engine values survive: Date stays a Date, bigint stays bigint.
		const born = loaded.facts.find((fact) => fact[1] === 'user/born')?.[2];
		expect(born).toBeInstanceOf(Date);
		expect((born as Date).getTime()).toBe(new Date('1990-01-02T03:04:05.000Z').getTime());

		const balance = loaded.facts.find((fact) => fact[1] === 'user/balance')?.[2];
		expect(typeof balance).toBe('bigint');
		expect(balance).toBe(10n);
	});

	it('round-trips Date / bigint / ref values inside transaction metadata', () => {
		const db = createDatabase();
		const at = new Date('2024-01-01T00:00:00.000Z');
		db.transact([['add', 1, 'a', 'x']], { source: 'fixture', at, count: 2n, ref: 7 });
		const snapshot = { facts: db.getFacts(), transactions: db.getTransactions() };

		const loaded = deserializeSnapshot(serializeSnapshot(snapshot));

		const metadata = loaded.transactions[0]?.[2];
		expect(metadata).toEqual({ source: 'fixture', at, count: 2n, ref: 7 });
	});

	it('rejects malformed payloads with clear errors', () => {
		expect(() => deserializeSnapshot({ version: 2, facts: [], transactions: [] })).toThrow(
			/expected \{ version: 1, facts, transactions \}/
		);
		expect(() => deserializeSnapshot({ version: 1, facts: 'nope', transactions: [] })).toThrow(
			/Invalid snapshot payload/
		);
		expect(() => deserializeSnapshot({ version: 1, facts: [[1, 'a']], transactions: [] })).toThrow(
			/fact at index 0 must be a 5-tuple/
		);
	});
});
