/**
 * @fatos/core - Core database engine
 * 
 * This module provides the core temporal fact database implementation.
 * It includes:
 * - Fact storage and management
 * - Transaction handling
 * - Index structures (EAVT, AEVT, AVET)
 * - Query engine (Datalog-style)
 */

export const version = '0.0.1';

export type FactOperation = 'add' | 'retract';

export type Fact = readonly [
	eid: number,
	attribute: string,
	value: unknown,
	tx: number,
	op: FactOperation
];

type EntityState = Record<string, unknown> & { id: number };

function normalizeTxLimit(tx?: number): number {
	return tx ?? Number.POSITIVE_INFINITY;
}

export class FactDatabase {
	private facts: Fact[] = [];
	private nextTx = 1;

	add(eid: number, attribute: string, value: unknown): Fact {
		const fact: Fact = [eid, attribute, value, this.nextTx++, 'add'];
		this.facts.push(fact);
		return fact;
	}

	retract(eid: number, attribute: string, value: unknown): Fact {
		const fact: Fact = [eid, attribute, value, this.nextTx++, 'retract'];
		this.facts.push(fact);
		return fact;
	}

	getFacts(): readonly Fact[] {
		return this.facts.slice();
	}

	getFactsByEntity(eid: number): readonly Fact[] {
		return this.facts.filter((fact) => fact[0] === eid);
	}

	getFactsByAttribute(attribute: string): readonly Fact[] {
		return this.facts.filter((fact) => fact[1] === attribute);
	}

	entity(eid: number, tx?: number): EntityState | null {
		const txLimit = normalizeTxLimit(tx);
		const state = new Map<string, unknown>();

		for (const [factEid, attribute, value, factTx, op] of this.facts) {
			if (factEid !== eid || factTx > txLimit) {
				continue;
			}

			if (op === 'add') {
				state.set(attribute, value);
			} else if (Object.is(state.get(attribute), value)) {
				state.delete(attribute);
			}
		}

		if (state.size === 0) {
			return null;
		}

		const entity: EntityState = { id: eid };
		for (const [attribute, value] of state) {
			entity[attribute] = value;
		}

		return entity;
	}

	find(criteria: Record<string, unknown>, tx?: number): EntityState[] {
		const txLimit = normalizeTxLimit(tx);
		const eids = new Set<number>();

		for (const [eid, , , factTx] of this.facts) {
			if (factTx <= txLimit) {
				eids.add(eid);
			}
		}

		const matches: EntityState[] = [];
		for (const eid of eids) {
			const entity = this.entity(eid, txLimit);
			if (!entity) {
				continue;
			}

			const doesMatch = Object.entries(criteria).every(([key, value]) => Object.is(entity[key], value));
			if (doesMatch) {
				matches.push(entity);
			}
		}

		return matches;
	}
}

export function createDatabase(): FactDatabase {
	return new FactDatabase();
}
