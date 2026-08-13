/**
 * Fatos example showcase.
 *
 * `runAll()` runs every example back to back and is what the CLI (src/cli.ts)
 * and the built bundle invoke. This module itself has no side effects, so it
 * can be imported freely by tests.
 */
import { section } from './helpers';
import { run as basicUsage } from './basic-usage';
import { run as schema } from './schema';
import { run as datalogQuery } from './datalog-query';
import { run as timeTravel } from './time-travel';
import { run as reactive } from './reactive';
import { run as serverExample } from './server-example';
import { run as reactExample } from './react-example';
import { run as schemaDesigner } from './schema-designer';
import { run as fullStackApp } from './full-stack-app';

export const version = '0.0.1';

export async function runAll(): Promise<void> {
	section('Fatos — temporal fact database showcase');
	console.log('Run individual examples with `npm run example:<name>` (see README.md).\n');

	basicUsage();
	schema();
	datalogQuery();
	timeTravel();
	reactive();
	await serverExample();
	reactExample();
	schemaDesigner();
	await fullStackApp();

	section('Showcase complete — all examples ran successfully');
}

