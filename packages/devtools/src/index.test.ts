/**
 * DevTools tests
 */

import { describe, it, expect, vi } from 'vitest';
import {
	EXTENSION_BRIDGE_SOURCE,
	PAGE_BRIDGE_SOURCE,
	createBrowserDevtoolsBridge,
	installInspectionRequestHandler,
	version
} from './index';

type MockWindow = {
	postMessage: ReturnType<typeof vi.fn>;
	addEventListener: ReturnType<typeof vi.fn>;
	removeEventListener: ReturnType<typeof vi.fn>;
};

describe('@fatos/devtools', () => {
	it('should export version', () => {
		expect(version).toBeDefined();
	});

	it('should publish page bridge messages when window is available', () => {
		const mockWindow: MockWindow = {
			postMessage: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn()
		};

		Object.defineProperty(globalThis, 'window', {
			value: mockWindow,
			configurable: true
		});

		const bridge = createBrowserDevtoolsBridge();
		bridge.publishSnapshot({ facts: [] });

		expect(mockWindow.postMessage).toHaveBeenCalledTimes(1);
		expect(mockWindow.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				source: PAGE_BRIDGE_SOURCE,
				kind: 'snapshot',
				payload: { facts: [] }
			}),
			'*'
		);
	});

	it('should no-op in non-browser environments', () => {
		Object.defineProperty(globalThis, 'window', {
			value: undefined,
			configurable: true
		});

		const bridge = createBrowserDevtoolsBridge();
		expect(() => bridge.publishEvent({ type: 'noop' })).not.toThrow();
	});

	it('should call inspection handler for extension inspect requests', () => {
		let registeredListener: ((event: MessageEvent<unknown>) => void) | null = null;
		const addEventListener = vi.fn((eventName: string, listener: (event: MessageEvent<unknown>) => void) => {
			if (eventName === 'message') {
				registeredListener = listener;
			}
		});
		const removeEventListener = vi.fn();

		const mockWindow = {
			postMessage: vi.fn(),
			addEventListener,
			removeEventListener
		};

		Object.defineProperty(globalThis, 'window', {
			value: mockWindow,
			configurable: true
		});

		const onInspectRequest = vi.fn();
		const unsubscribe = installInspectionRequestHandler(onInspectRequest);

		expect(addEventListener).toHaveBeenCalledTimes(1);
		expect(registeredListener).not.toBeNull();

		registeredListener?.({
			source: mockWindow,
			data: {
				source: EXTENSION_BRIDGE_SOURCE,
				kind: 'inspect-request'
			}
		} as MessageEvent<unknown>);

		expect(onInspectRequest).toHaveBeenCalledTimes(1);

		unsubscribe();
		expect(removeEventListener).toHaveBeenCalledTimes(1);
	});
});
