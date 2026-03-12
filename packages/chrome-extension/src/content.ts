/**
 * Chrome Extension content script
 */

type BridgeKind = 'snapshot' | 'event';

type ChromeLike = {
	runtime?: {
		sendMessage?: (message: unknown) => void;
		onMessage?: {
			addListener: (listener: (message: unknown) => void) => void;
		};
	};
};

export const PAGE_BRIDGE_SOURCE = 'fatos:page';
export const EXTENSION_BRIDGE_SOURCE = 'fatos:extension';

export type PageBridgeMessage = {
	source: typeof PAGE_BRIDGE_SOURCE;
	kind: BridgeKind;
	payload: unknown;
	timestamp: number;
};

function getChromeApi(): ChromeLike | undefined {
	return (globalThis as { chrome?: ChromeLike }).chrome;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

export function isPageBridgeMessage(value: unknown): value is PageBridgeMessage {
	if (!isObject(value)) {
		return false;
	}

	if (value.source !== PAGE_BRIDGE_SOURCE) {
		return false;
	}

	if (value.kind !== 'snapshot' && value.kind !== 'event') {
		return false;
	}

	return typeof value.timestamp === 'number';
}

function initContentBridge(): void {
	if (typeof window === 'undefined') {
		return;
	}

	const chromeApi = getChromeApi();
	if (!chromeApi?.runtime?.sendMessage) {
		return;
	}

	window.addEventListener('message', (event: MessageEvent<unknown>) => {
		if (event.source !== window || !isPageBridgeMessage(event.data)) {
			return;
		}

		chromeApi.runtime?.sendMessage?.({
			type: 'fatos:bridge-event',
			kind: event.data.kind,
			payload: event.data.payload,
			timestamp: event.data.timestamp,
			url: window.location.href
		});
	});

	chromeApi.runtime.onMessage?.addListener((message: unknown) => {
		if (!isObject(message) || message.type !== 'fatos:inspect-request') {
			return;
		}

		window.postMessage({
			source: EXTENSION_BRIDGE_SOURCE,
			kind: 'inspect-request'
		}, '*');
	});

	chromeApi.runtime.sendMessage({
		type: 'fatos:content-ready',
		url: window.location.href
	});
}

initContentBridge();
