/**
 * Minimal REST surface the browser client uses to WRITE.
 *
 * The syncing client is a read-only live mirror — the server is authoritative.
 * Writes go to `POST /transact`; the broadcast then reaches every tab's local
 * mirror, which replays the transaction and wakes the right live queries.
 */
export function apiBase(wsUrl: string): string {
	return wsUrl
		.replace(/^wss:\/\//, 'https://')
		.replace(/^ws:\/\//, 'http://')
		.replace(/\/ws$/, '');
}

export async function postTransact(
	baseUrl: string,
	entries: unknown[],
	metadata?: Record<string, unknown>
): Promise<{ facts: unknown[]; transaction: unknown }> {
	const response = await fetch(`${baseUrl}/transact`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ entries, metadata })
	});
	if (!response.ok) {
		throw new Error(`POST /transact failed: ${response.status} ${await response.text()}`);
	}
	return (await response.json()) as { facts: unknown[]; transaction: unknown };
}
