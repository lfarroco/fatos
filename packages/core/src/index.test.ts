/**
 * Core database engine tests
 */

import { describe, it, expect } from 'vitest';
import { version } from './index';

describe('@fatos/core', () => {
	it('should export version', () => {
		expect(version).toBeDefined();
	});
});
