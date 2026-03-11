/**
 * Server tests
 */

import { describe, it, expect } from 'vitest';
import { version } from './index';

describe('@fatos/server', () => {
	it('should export version', () => {
		expect(version).toBeDefined();
	});
});
