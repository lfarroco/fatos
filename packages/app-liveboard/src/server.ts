/**
 * LiveBoard server — the realtime collaboration niche probe.
 *
 * One `FatosServer` is the single source of truth; every syncing browser
 * client mirrors it over WebSocket. Card moves are REST writes that the server
 * broadcasts, and each tab's live queries re-render only the column that
 * changed.
 *
 * Run with `npm run server` (cwd = this package, data goes to ./data).
 */
import { join } from 'node:path';
import { FileAdapter } from '@fatos/persistence';
import { createFatosServer } from '@fatos/server';
import { seedIfEmpty } from './seed';

const port = Number(process.env.PORT ?? 4200);
const host = process.env.HOST ?? '127.0.0.1';

async function main(): Promise<void> {
	const dataFile = join(process.cwd(), 'data', 'liveboard.json');
	const storage = new FileAdapter(dataFile);
	const server = createFatosServer({ storage });

	const shuttingDown = { value: false };
	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown.value) {
			return;
		}
		shuttingDown.value = true;
		console.log(`[liveboard] ${signal} — flushing and stopping`);
		try {
			await server.flush();
		} catch (error) {
			console.error('[liveboard] persistence flush failed', error);
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
	console.log(`[liveboard] server http://${host}:${actualPort}`);
	console.log(`[liveboard] websocket ws://${host}:${actualPort}/ws`);
	console.log(`[liveboard] persistence ${dataFile}`);

	seedIfEmpty(server);
	console.log('[liveboard] ready');
}

void main();

