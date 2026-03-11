/**
 * DevTools tests
 */

import { describe, it, expect } from 'vitest';
import { version } from './index';

describe('@fatos/devtools', () => {
	it('should export version', () => {
		expect(version).toBeDefined();
	});
});
