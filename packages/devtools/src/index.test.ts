/**
 * DevTools tests
 */

import { describe, it, expect, vi } from 'vitest';
import { createClient } from '@fatos/client';
import { ref } from '@fatos/core';
import {
	EXTENSION_BRIDGE_SOURCE,
	PAGE_BRIDGE_SOURCE,
	createBrowserDevtoolsBridge,
	installInspectionRequestHandler,
	installSnapshotPublisher,
	version
} from './index';
import type { PageBridgeMessage } from './index';
import type { FactSnapshot } from './snapshot';

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

	function installMockWindow(): MockWindow {
		const mockWindow: MockWindow = {
			postMessage: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn()
		};
		Object.defineProperty(globalThis, 'window', {
			value: mockWindow,
			configurable: true
		});
		return mockWindow;
	}

	function lastSnapshot(mockWindow: MockWindow): FactSnapshot {
		const messages = mockWindow.postMessage.mock.calls.map((call) => call[0] as PageBridgeMessage);
		const last = messages[messages.length - 1];
		expect(last.source).toBe(PAGE_BRIDGE_SOURCE);
		expect(last.kind).toBe('snapshot');
		return last.payload as FactSnapshot;
	}

	it('should publish a snapshot on every committed transaction and stop after dispose', () => {
		const mockWindow = installMockWindow();
		const client = createClient();

		const publisher = installSnapshotPublisher(client);
		expect(mockWindow.postMessage).toHaveBeenCalledTimes(1); // initial publish

		client.add(1, 'demo/name', 'Alice');
		expect(mockWindow.postMessage).toHaveBeenCalledTimes(2);

		const payload = lastSnapshot(mockWindow);
		expect(payload.facts).toEqual([[1, 'demo/name', 'Alice', 1, 'add']]);
		expect(payload.transactions).toEqual([[1, expect.any(Number), null]]);
		expect(typeof payload.capturedAt).toBe('number');

		publisher.dispose();
		client.add(1, 'demo/name', 'Alicia');
		expect(mockWindow.postMessage).toHaveBeenCalledTimes(2);
	});

	it('should publish a snapshot when the extension requests an inspection', () => {
		let registeredListener: ((event: MessageEvent<unknown>) => void) | null = null;
		const mockWindow: MockWindow = {
			postMessage: vi.fn(),
			addEventListener: vi.fn((eventName: string, listener: (event: MessageEvent<unknown>) => void) => {
				if (eventName === 'message') {
					registeredListener = listener;
				}
			}),
			removeEventListener: vi.fn()
		};
		Object.defineProperty(globalThis, 'window', {
			value: mockWindow,
			configurable: true
		});

		const client = createClient();
		client.add(1, 'demo/name', 'Alice'); // committed before install
		const publisher = installSnapshotPublisher(client); // initial publish

		expect(mockWindow.postMessage).toHaveBeenCalledTimes(1);

		registeredListener?.({
			source: mockWindow,
			data: {
				source: EXTENSION_BRIDGE_SOURCE,
				kind: 'inspect-request'
			}
		} as MessageEvent<unknown>);

		expect(mockWindow.postMessage).toHaveBeenCalledTimes(2);
		const payload = lastSnapshot(mockWindow);
		expect(payload.facts).toHaveLength(1);
		expect(payload.url).toBeUndefined(); // no `location` in the node test environment

		publisher.dispose();
	});

	it('should serialize engine values to wire form for the bridge', () => {
		const mockWindow = installMockWindow();
		const client = createClient();
		client.add(1, 'demo/date', new Date('2024-01-02T03:04:05.000Z'));
		client.add(1, 'demo/ref', ref(42));
		client.add(1, 'demo/bigint', 9007199254740993n);

		installSnapshotPublisher(client);

		const payload = lastSnapshot(mockWindow);
		expect(payload.facts.map((fact) => fact[2])).toEqual([
			{ $date: 1704164645000 },
			{ $ref: 42 },
			{ $bigint: '9007199254740993' }
		]);
	});

	it('should skip the initial publish when publishInitial is false', () => {
		const mockWindow = installMockWindow();
		const client = createClient();

		const publisher = installSnapshotPublisher(client, { publishInitial: false });
		expect(mockWindow.postMessage).not.toHaveBeenCalled();

		client.add(1, 'demo/name', 'Alice');
		expect(mockWindow.postMessage).toHaveBeenCalledTimes(1);
		expect(lastSnapshot(mockWindow).facts).toEqual([[1, 'demo/name', 'Alice', 1, 'add']]);

		publisher.dispose();
	});

	it('should guard for no-window environments', () => {
		Object.defineProperty(globalThis, 'window', {
			value: undefined,
			configurable: true
		});

		const client = createClient();
		const publisher = installSnapshotPublisher(client);

		expect(() => {
			client.add(1, 'demo/name', 'Alice');
			publisher.publish();
			publisher.dispose();
			publisher.dispose(); // double dispose is safe
		}).not.toThrow();
	});
});
