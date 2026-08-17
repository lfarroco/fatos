/**
 * Ops Desk server — the audit/operations niche probe.
 *
 * A `FatosServer` with file persistence: the same in-memory engine as the
 * browser client, but server-authoritative. Every write goes through
 * `POST /transact`, is appended to a JSONL file (`append` fast path), and is
 * broadcast to every syncing client over WebSocket. On restart the fact log
 * is replayed, so "stock as of last Tuesday" survives the process.
 *
 * Run with `npm run server` (cwd = this package, data goes to ./data).
 */
import { join } from 'node:path';
import { FileAdapter } from '@fatos/persistence';
import { createFatosServer } from '@fatos/server';
import { seedIfEmpty } from './seed';

const port = Number(process.env.PORT ?? 4100);
const host = process.env.HOST ?? '127.0.0.1';

async function main(): Promise<void> {
	const dataFile = join(process.cwd(), 'data', 'ops-desk.json');
	const storage = new FileAdapter(dataFile);
	const server = createFatosServer({ storage });

	const shuttingDown = { value: false };
	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown.value) {
			return;
		}
		shuttingDown.value = true;
		console.log(`[ops-desk] ${signal} — flushing and stopping`);
		try {
			await server.flush();
		} catch (error) {
			console.error('[ops-desk] persistence flush failed', error);
		}
		await server.stop();
		process.exit(0);
	};

	process.on('SIGINT', () => {
		void shutdown('SIGINT');
	});
	process.on('SIGTERM', () => {
		void shutdown('SIGTERM');
	});

	const { port: actualPort } = await server.start({ port, host });
	console.log(`[ops-desk] server http://${host}:${actualPort}`);
	console.log(`[ops-desk] websocket ws://${host}:${actualPort}/ws`);
	console.log(`[ops-desk] persistence ${dataFile}`);

	// Seed the catalog + a starter order only when the store is empty.
	seedIfEmpty(server);
	console.log('[ops-desk] ready');
}

void main();

