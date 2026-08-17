import { defineConfig, devices } from '@playwright/test';

/**
 * Browser E2E tests — drive the real demo apps in a real browser.
 *
 * The Replay app (@fatos/app-replay) is browser-only: the `webServer` command
 * runs esbuild's dev server (bundles `static/app.js` and serves `static/` on
 * port 4175), so the test exercises the actual UI with no backend.
 */
export default defineConfig({
	testDir: './e2e',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: 'list',
	use: {
		baseURL: 'http://localhost:4175',
		trace: 'on-first-retry'
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: {
		command: 'npm run client --workspace @fatos/app-replay',
		url: 'http://localhost:4175',
		reuseExistingServer: !process.env.CI,
		timeout: 120_000
	}
});
