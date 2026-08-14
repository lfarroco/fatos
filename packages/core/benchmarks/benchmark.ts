/**
 * P0 benchmark suite for @fatos/core.
 *
 * Seeds 10k entities / 20k facts and times the four P0 acceptance paths from
 * docs/design/04-phasing.md against their targets:
 *
 *   - ingest                     < 200 ms
 *   - single-clause query        < 10 ms
 *   - 2-clause datalog join      < 50 ms
 *   - find by attribute value    < 10 ms
 *
 * Run with: npm run benchmark (packages/core) — no wall-clock assertions live
 * in the vitest suite; this script only reports measured numbers.
 */

import { createDatabase } from '../src/index.ts';
import type { EntityId, FactDatabase } from '../src/index.ts';

const ENTITY_COUNT = 10_000;
const FACTS_PER_ENTITY = 2;
const RUNS = 5;

type BenchResult = {
	name: string;
	bestMs: number;
	avgMs: number;
	targetMs: number;
};

function time(fn: () => unknown): number {
	const start = performance.now();
	fn();
	return performance.now() - start;
}

function seed(db: FactDatabase): void {
	// 10k entities × 2 facts (type + age) = 20k facts, committed in batches.
	const BATCH = 500;
	for (let start = 0; start < ENTITY_COUNT; start += BATCH) {
		const mutations: Array<['add', EntityId, string, unknown]> = [];
		for (let i = start; i < Math.min(start + BATCH, ENTITY_COUNT); i += 1) {
			mutations.push(['add', i, 'type', i % 2 === 0 ? 'user' : 'admin']);
			mutations.push(['add', i, 'age', i % 50]);
		}
		db.transact(mutations);
	}
}

function bench(name: string, targetMs: number, fn: () => unknown): BenchResult {
	// Warm-up run so JIT/IC profiling doesn't skew the measured numbers.
	fn();

	let best = Number.POSITIVE_INFINITY;
	let total = 0;
	for (let run = 0; run < RUNS; run += 1) {
		const ms = time(fn);
		best = Math.min(best, ms);
		total += ms;
	}

	return {
		name,
		bestMs: best,
		avgMs: total / RUNS,
		targetMs
	};
}

function format(result: BenchResult): string {
	const pass = result.bestMs < result.targetMs ? 'PASS' : 'FAIL';
	const label = result.name.padEnd(28);
	return `${label} best ${result.bestMs.toFixed(2).padStart(8)} ms  avg ${result.avgMs.toFixed(2).padStart(8)} ms  target < ${String(result.targetMs).padStart(3)} ms  ${pass}`;
}

function main(): void {
	const db = createDatabase();

	console.log('Fatos core benchmark — 10k entities / 20k facts');
	console.log('='.repeat(78));

	const ingestMs = time(() => seed(db));
	const factCount = db.getFacts().length;
	if (factCount !== ENTITY_COUNT * FACTS_PER_ENTITY) {
		throw new Error(`Expected ${ENTITY_COUNT * FACTS_PER_ENTITY} facts, got ${factCount}`);
	}
	console.log(`seeded ${factCount} facts across ${ENTITY_COUNT} entities in ${ingestMs.toFixed(2)} ms`);

	const results: BenchResult[] = [
		bench('ingest', 200, () => {
			const fresh = createDatabase();
			seed(fresh);
		}),
		bench('single-clause query', 10, () => {
			const rows = db.query({
				find: ['?e'],
				where: [['?e', 'type', 'user']]
			});
			if (rows.length !== ENTITY_COUNT / 2) {
				throw new Error(`single-clause query returned ${rows.length} rows`);
			}
		}),
		bench('2-clause datalog join', 50, () => {
			const rows = db.query({
				find: ['?e', '?a'],
				where: [
					['?e', 'type', 'user'],
					['?e', 'age', '?a']
				]
			});
			if (rows.length !== ENTITY_COUNT / 2) {
				throw new Error(`join returned ${rows.length} rows`);
			}
		}),
		bench('find by attribute value', 10, () => {
			const matches = db.find({ age: 33 });
			if (matches.length === 0) {
				throw new Error('find by attribute value returned no rows');
			}
		})
	];

	console.log('');
	for (const result of results) {
		console.log(format(result));
	}

	const failed = results.filter((result) => result.bestMs >= result.targetMs);
	console.log('');
	if (failed.length === 0) {
		console.log('All benchmark targets met.');
	} else {
		console.log(
			`Benchmark targets MISSED: ${failed.map((result) => result.name).join(', ')}`
		);
		process.exitCode = 1;
	}
}

main();
