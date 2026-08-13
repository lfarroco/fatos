/**
 * Dev runner for individual examples.
 *
 * Usage (from packages/examples):
 *   npm run example:basic          # run one example
 *   npm run example                # run everything
 *
 * Or directly:
 *   npx vite-node src/cli.ts time-travel
 */
import { runAll } from './index';
import { run as basicUsage } from './basic-usage';
import { run as schema } from './schema';
import { run as datalogQuery } from './datalog-query';
import { run as timeTravel } from './time-travel';
import { run as reactive } from './reactive';
import { run as serverExample } from './server-example';
import { run as reactExample } from './react-example';
import { run as schemaDesigner } from './schema-designer';
import { run as fullStackApp } from './full-stack-app';

const examples: Record<string, () => unknown> = {
	all: runAll,
	basic: basicUsage,
	schema,
	query: datalogQuery,
	'time-travel': timeTravel,
	reactive,
	server: serverExample,
	react: reactExample,
	'schema-designer': schemaDesigner,
	'full-stack': fullStackApp
};

const name = process.argv[2] ?? 'all';
const run = examples[name] ?? examples['all'];

void Promise.resolve(run()).catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
