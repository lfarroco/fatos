import { defineConfig } from 'tsup';

/**
 * Standalone bundle for the DevTools browser harness (browser-harness.html).
 *
 * Unlike the CLI build, this inlines @fatos/client, @fatos/core, and
 * @fatos/devtools (noExternal) into one self-contained IIFE, so the page can
 * be served over plain HTTP without a bundler or a node_modules resolution.
 * The bundle auto-mounts into #fatos-browser-harness when loaded.
 */
export default defineConfig({
	entry: ['src/browser-harness.ts'],
	format: ['iife'],
	platform: 'browser',
	noExternal: ['@fatos/client', '@fatos/core', '@fatos/devtools'],
	globalName: 'FatosHarness',
	outDir: 'dist',
	clean: false
});
