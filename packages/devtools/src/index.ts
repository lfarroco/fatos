/**
 * @fatos/devtools - DevTools inspector
 *
 * This module provides DevTools components and utilities.
 * Includes:
 * - Fact table viewer
 * - Entity inspector
 * - Query console
 * - Timeline visualization
 * - Diff viewer
 */

export const version = '0.0.1';

export const PAGE_BRIDGE_SOURCE = 'fatos:page';
export const EXTENSION_BRIDGE_SOURCE = 'fatos:extension';

export type BridgeMessageKind = 'snapshot' | 'event';

export type PageBridgeMessage = {
	source: typeof PAGE_BRIDGE_SOURCE;
	kind: BridgeMessageKind;
	payload: unknown;
	timestamp: number;
};

type ExtensionInspectRequestMessage = {
	source: typeof EXTENSION_BRIDGE_SOURCE;
	kind: 'inspect-request';
};

export type BrowserDevtoolsBridge = {
	publishSnapshot(snapshot: unknown): void;
	publishEvent(event: unknown): void;
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function hasWindowPostMessage(value: unknown): value is { postMessage: (message: unknown, targetOrigin: string) => void } {
	return isObject(value) && typeof value.postMessage === 'function';
}

function postPageBridgeMessage(kind: BridgeMessageKind, payload: unknown): void {
	if (!hasWindowPostMessage(globalThis.window)) {
		return;
	}

	const message: PageBridgeMessage = {
		source: PAGE_BRIDGE_SOURCE,
		kind,
		payload,
		timestamp: Date.now()
	};

	globalThis.window.postMessage(message, '*');
}

export function createBrowserDevtoolsBridge(): BrowserDevtoolsBridge {
	return {
		publishSnapshot(snapshot: unknown): void {
			postPageBridgeMessage('snapshot', snapshot);
		},
		publishEvent(event: unknown): void {
			postPageBridgeMessage('event', event);
		}
	};
}

function isInspectRequest(value: unknown): value is ExtensionInspectRequestMessage {
	if (!isObject(value)) {
		return false;
	}

	return value.source === EXTENSION_BRIDGE_SOURCE && value.kind === 'inspect-request';
}

export function installInspectionRequestHandler(onInspectRequest: () => void): () => void {
	if (typeof window === 'undefined') {
		return () => undefined;
	}

	const listener = (event: MessageEvent<unknown>): void => {
		if (event.source !== window) {
			return;
		}

		if (!isInspectRequest(event.data)) {
			return;
		}

		onInspectRequest();
	};

	window.addEventListener('message', listener);
	return () => {
		window.removeEventListener('message', listener);
	};
}
