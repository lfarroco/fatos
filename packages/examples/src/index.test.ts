/**
 * Examples tests
 */

import { describe, it, expect } from 'vitest';
import { version } from './index';

describe('@fatos/examples', () => {
	it('should export version', () => {
		expect(version).toBeDefined();
	});
});
