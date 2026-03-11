/**
 * Browser client tests
 */

import { describe, it, expect } from 'vitest';
import { version } from './index';

describe('@fatos/client', () => {
	it('should export version', () => {
		expect(version).toBeDefined();
	});
});
