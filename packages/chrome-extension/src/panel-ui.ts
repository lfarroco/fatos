type BridgeKind = 'snapshot' | 'event';

type TabBridgeState = {
	url: string;
	lastUpdated: number | null;
	latestEvent: {
		kind: BridgeKind;
		payload: unknown;
		timestamp: number;
	} | null;
};

type PanelStateMessage = {
	type: 'fatos:state';
	tabId: number;
	state: TabBridgeState;
};

type RuntimePort = {
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
		connect: (options: { name: string }) => RuntimePort;
	};
};

function getChromeApi(): ChromeLike | undefined {
	return (globalThis as { chrome?: ChromeLike }).chrome;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isPanelStateMessage(value: unknown): value is PanelStateMessage {
	if (!isObject(value)) {
		return false;
	}

	return value.type === 'fatos:state' && typeof value.tabId === 'number' && isObject(value.state);
}

function formatTimestamp(timestamp: number | null): string {
	if (timestamp === null) {
		return 'waiting for events';
	}

	return new Date(timestamp).toLocaleTimeString();
}

function parseTabId(): number | null {
	const raw = new URLSearchParams(window.location.search).get('tabId');
	if (raw === null) {
		return null;
	}

	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 0) {
		return null;
	}

	return parsed;
}

function setText(id: string, text: string): void {
	const element = document.getElementById(id);
	if (!element) {
		return;
	}

	element.textContent = text;
}

function renderState(state: TabBridgeState): void {
	setText('status', `connected to ${state.url}`);
	setText('updated-at', `last update: ${formatTimestamp(state.lastUpdated)}`);

	const eventType = state.latestEvent ? state.latestEvent.kind : 'none';
	setText('event-type', `latest event: ${eventType}`);

	setText('payload', JSON.stringify(state.latestEvent?.payload ?? null, null, 2));
}

function initPanelUi(): void {
	const tabId = parseTabId();
	if (tabId === null) {
		setText('status', 'missing tab id; reopen the panel from DevTools');
		return;
	}

	const chromeApi = getChromeApi();
	if (!chromeApi?.runtime?.connect) {
		setText('status', 'runtime API unavailable');
		return;
	}

	const port = chromeApi.runtime.connect({ name: 'fatos-devtools-panel' });

	port.onMessage?.addListener((message: unknown) => {
		if (!isPanelStateMessage(message)) {
			return;
		}

		renderState(message.state);
	});

	port.onDisconnect?.addListener(() => {
		setText('status', 'disconnected');
	});

	const inspectButton = document.getElementById('inspect-btn');
	inspectButton?.addEventListener('click', () => {
		port.postMessage({ type: 'fatos:panel-request-inspect' });
	});

	setText('status', 'connecting...');
	port.postMessage({ type: 'fatos:panel-init', tabId });
}

initPanelUi();

export {};