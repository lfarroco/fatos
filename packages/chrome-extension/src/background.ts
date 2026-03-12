/**
 * Chrome Extension background script
 */

type BridgeKind = 'snapshot' | 'event';

type BridgeEvent = {
	kind: BridgeKind;
	payload: unknown;
	timestamp: number;
};

type TabBridgeState = {
	url: string;
	lastUpdated: number | null;
	latestEvent: BridgeEvent | null;
};

type ContentReadyMessage = {
	type: 'fatos:content-ready';
	url: string;
};

type ContentBridgeMessage = {
	type: 'fatos:bridge-event';
	kind: BridgeKind;
	payload: unknown;
	timestamp: number;
	url: string;
};

type PanelInitMessage = {
	type: 'fatos:panel-init';
	tabId: number;
};

type PanelRequestInspectMessage = {
	type: 'fatos:panel-request-inspect';
};

type RuntimeMessage = ContentReadyMessage | ContentBridgeMessage | PanelInitMessage | PanelRequestInspectMessage;

type RuntimePort = {
	name?: string;
	postMessage: (message: unknown) => void;
	onMessage?: {
		addListener: (listener: (message: unknown) => void) => void;
	};
	onDisconnect?: {
		addListener: (listener: () => void) => void;
	};
};

type ChromeLike = {
	runtime?: {
		onMessage?: {
			addListener: (listener: (message: unknown, sender: { tab?: { id?: number } | undefined }) => void) => void;
		};
		onConnect?: {
			addListener: (listener: (port: RuntimePort) => void) => void;
		};
	};
	tabs?: {
		sendMessage: (tabId: number, message: unknown) => void;
	};
};

const tabStates = new Map<number, TabBridgeState>();
const panelPortsByTab = new Map<number, Set<RuntimePort>>();

function getChromeApi(): ChromeLike | undefined {
	return (globalThis as { chrome?: ChromeLike }).chrome;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isRuntimeMessage(value: unknown): value is RuntimeMessage {
	if (!isObject(value) || typeof value.type !== 'string') {
		return false;
	}

	return value.type === 'fatos:content-ready'
		|| value.type === 'fatos:bridge-event'
		|| value.type === 'fatos:panel-init'
		|| value.type === 'fatos:panel-request-inspect';
}

function getOrCreateTabState(tabId: number, url: string): TabBridgeState {
	const existing = tabStates.get(tabId);
	if (existing) {
		existing.url = url;
		return existing;
	}

	const created: TabBridgeState = {
		url,
		lastUpdated: null,
		latestEvent: null
	};
	tabStates.set(tabId, created);
	return created;
}

function addPortToTab(tabId: number, port: RuntimePort): void {
	const current = panelPortsByTab.get(tabId) ?? new Set<RuntimePort>();
	current.add(port);
	panelPortsByTab.set(tabId, current);
}

function removePortFromTab(tabId: number, port: RuntimePort): void {
	const current = panelPortsByTab.get(tabId);
	if (!current) {
		return;
	}

	current.delete(port);
	if (current.size === 0) {
		panelPortsByTab.delete(tabId);
	}
}

function postStateToTabPorts(tabId: number): void {
	const state = tabStates.get(tabId);
	const ports = panelPortsByTab.get(tabId);
	if (!state || !ports) {
		return;
	}

	for (const port of ports) {
		port.postMessage({
			type: 'fatos:state',
			tabId,
			state
		});
	}
}

function onRuntimeMessage(message: unknown, sender: { tab?: { id?: number } | undefined }): void {
	if (!isRuntimeMessage(message)) {
		return;
	}

	const tabId = sender.tab?.id;
	if (typeof tabId !== 'number') {
		return;
	}

	if (message.type === 'fatos:content-ready') {
		getOrCreateTabState(tabId, message.url);
		postStateToTabPorts(tabId);
		return;
	}

	if (message.type === 'fatos:bridge-event') {
		const state = getOrCreateTabState(tabId, message.url);
		state.lastUpdated = message.timestamp;
		state.latestEvent = {
			kind: message.kind,
			payload: message.payload,
			timestamp: message.timestamp
		};
		postStateToTabPorts(tabId);
	}
}

function onPanelPortConnected(port: RuntimePort): void {
	if (port.name !== 'fatos-devtools-panel') {
		return;
	}

	let boundTabId: number | null = null;

	port.onMessage?.addListener((message: unknown) => {
		if (!isRuntimeMessage(message)) {
			return;
		}

		if (message.type === 'fatos:panel-init') {
			boundTabId = message.tabId;
			addPortToTab(boundTabId, port);

			const state = tabStates.get(boundTabId) ?? {
				url: 'unknown',
				lastUpdated: null,
				latestEvent: null
			};

			port.postMessage({
				type: 'fatos:state',
				tabId: boundTabId,
				state
			});
			return;
		}

		if (message.type === 'fatos:panel-request-inspect' && typeof boundTabId === 'number') {
			getChromeApi()?.tabs?.sendMessage(boundTabId, { type: 'fatos:inspect-request' });
		}
	});

	port.onDisconnect?.addListener(() => {
		if (typeof boundTabId === 'number') {
			removePortFromTab(boundTabId, port);
		}
	});
}

const chromeApi = getChromeApi();
chromeApi?.runtime?.onMessage?.addListener(onRuntimeMessage);
chromeApi?.runtime?.onConnect?.addListener(onPanelPortConnected);

export {};
