import { expect, test } from '@playwright/test';

/**
 * E2E tests for the Replay demo app (@fatos/app-replay) in a real browser.
 *
 * The app is browser-only (no server): every action is an append-only
 * transaction on a local fact database, and the timeline / diff / undo panels
 * are plain reads over that log. These tests drive the real UI and assert the
 * temporal behaviors the app is built to showcase.
 */

// The board's schema lives in transaction 1; every user action adds one more.
const SCHEMA_TX = 1;

test('adds nodes and time-travels back to an earlier state', async ({ page }) => {
	await page.goto('/');

	// Empty board, live at the schema transaction.
	await expect(page.locator('.node')).toHaveCount(0);
	await expect(page.getByText('tx 1 / 1')).toBeVisible();
	await expect(page.locator('.badge-live')).toBeVisible();

	// Add two nodes → two more transactions.
	const addNode = page.getByRole('button', { name: '+ Add node' });
	await addNode.click();
	await addNode.click();
	await expect(page.locator('.node')).toHaveCount(2);
	await expect(page.getByText('tx 3 / 3')).toBeVisible();

	// Scrub back before either node: the board shows no nodes (as-of).
	await page.locator('.scrubber input[type="range"]').fill(String(SCHEMA_TX));
	await expect(page.locator('.node')).toHaveCount(0);
	await expect(page.getByText('tx 1 / 3')).toBeVisible();
	await expect(page.getByText('as-of')).toBeVisible();

	// Back to live: both nodes return.
	await page.getByRole('button', { name: 'live' }).click();
	await expect(page.locator('.node')).toHaveCount(2);
	await expect(page.getByText('tx 3 / 3')).toBeVisible();
	await expect(page.locator('.badge-live')).toBeVisible();
});

test('undo removes a step but keeps the history', async ({ page }) => {
	await page.goto('/');

	await page.getByRole('button', { name: '+ Add node' }).click();
	await page.getByRole('button', { name: '+ Add node' }).click();
	await expect(page.locator('.node')).toHaveCount(2);

	// Undo the last step: one node is retracted.
	await page.getByRole('button', { name: 'Undo' }).click();
	await expect(page.locator('.node')).toHaveCount(1);

	// The undo is a new transaction, not an erased one — history grows.
	await expect(page.getByText('4 transactions in the log')).toBeVisible();
	// The diff panel shows the retracted facts of the undone step.
	await expect(page.locator('.diff .retract-fact')).toHaveCount(3);
});

test('connecting two nodes draws an edge', async ({ page }) => {
	await page.goto('/');

	await page.getByRole('button', { name: '+ Add node' }).click();
	await page.getByRole('button', { name: '+ Add node' }).click();
	await expect(page.locator('.node')).toHaveCount(2);

	// Selects list every node after the placeholder; both default to "Node".
	const selects = page.locator('.toolbar select');
	await selects.nth(0).selectOption({ index: 1 }); // from = first node
	await selects.nth(1).selectOption({ index: 2 }); // to = second node
	await page.getByRole('button', { name: 'Connect' }).click();

	await expect(page.locator('svg.edges line.edge')).toHaveCount(1);
});
