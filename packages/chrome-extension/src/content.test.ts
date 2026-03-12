import { describe, expect, it } from 'vitest';
import { PAGE_BRIDGE_SOURCE, isPageBridgeMessage } from './content';

describe('content bridge message guard', () => {
	it('accepts valid page bridge messages', () => {
		expect(
			isPageBridgeMessage({
				source: PAGE_BRIDGE_SOURCE,
				kind: 'snapshot',
				payload: { facts: [] },
				timestamp: Date.now()
			})
		).toBe(true);
	});

	it('rejects invalid messages', () => {
		expect(
			isPageBridgeMessage({
				source: 'other',
				kind: 'snapshot',
				payload: null,
				timestamp: Date.now()
			})
		).toBe(false);

		expect(
			isPageBridgeMessage({
				source: PAGE_BRIDGE_SOURCE,
				kind: 'unknown',
				payload: null,
				timestamp: Date.now()
			})
		).toBe(false);

		expect(isPageBridgeMessage(null)).toBe(false);
	});
});