/**
 * Shared helpers for the Fatos examples.
 *
 * Every example is a plain TypeScript program that prints its results to the
 * console. The same `run()` functions are imported by the test suite, so every
 * example doubles as a live behavior check.
 */

/** Print a banner for a section of the showcase. */
export function section(title: string): void {
	console.log('');
	console.log('='.repeat(78));
	console.log(`  ${title}`);
	console.log('='.repeat(78));
}

/** Print a labelled, pretty-printed value. */
export function log(label: string, value: unknown): void {
	const rendered = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
	console.log(`\n[${label}]\n${rendered}`);
}

/** Poll until `predicate` becomes true or the timeout elapses. */
export async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start >= timeoutMs) {
			throw new Error('Timed out waiting for condition');
		}

		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
