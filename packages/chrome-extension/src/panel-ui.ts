import {
	DevtoolsPanelController,
	buildGraphModel,
	downloadSnapshot,
	formatValue,
	groupFactsByEntity,
	layoutGraph,
	pickSnapshotFile,
	renderDiff,
	renderEntityView,
	renderFactTable,
	renderGraphSvg,
	renderNotice,
	renderQueryResults,
	renderTimeline,
	serializeSnapshot
} from '@fatos/devtools';
import type { DevtoolsTabId, FactSnapshot, QuerySpec } from '@fatos/devtools';

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

const TABS: DevtoolsTabId[] = ['facts', 'entities', 'timeline', 'diff', 'query', 'time-travel', 'graph'];

const controller = new DevtoolsPanelController();

let selectedEntityIndex = 0;
let diffConsole: {
	root: HTMLElement;
	txA: HTMLInputElement;
	txB: HTMLInputElement;
	results: HTMLElement;
} | null = null;
let queryConsole: {
	root: HTMLElement;
	input: HTMLTextAreaElement;
	error: HTMLElement;
	results: HTMLElement;
} | null = null;

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

function appendNode(container: HTMLElement, node: Node | null): void {
	if (node !== null) {
		container.appendChild(node);
	}
}

function renderState(state: TabBridgeState): void {
	setText('status', `connected to ${state.url}`);
	setText('updated-at', `last update: ${formatTimestamp(state.lastUpdated)}`);

	const eventType = state.latestEvent ? state.latestEvent.kind : 'none';
	setText('event-type', `latest event: ${eventType}`);
}

function updateTabBar(): void {
	const active = controller.getActiveTab();
	for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('#tab-bar .tab'))) {
		const tab = button.dataset['tab'] as DevtoolsTabId | undefined;
		button.classList.toggle('active', tab === active);
	}
}

function renderFactsTab(content: HTMLElement): void {
	appendNode(content, renderFactTable(controller.getFacts()));
}

function renderEntitiesTab(content: HTMLElement): void {
	const facts = controller.getFacts();
	const groups = groupFactsByEntity(facts);
	const eids = [...groups.keys()];

	if (eids.length === 0) {
		appendNode(content, renderNotice('no entities yet'));
		return;
	}

	selectedEntityIndex = Math.min(Math.max(selectedEntityIndex, 0), eids.length - 1);
	const eid = eids[selectedEntityIndex];

	const select = document.createElement('select');
	select.style.cssText = 'font-family: inherit; font-size: 12px; padding: 4px 6px; border: 1px solid #94a3b8; border-radius: 6px; background: #ffffff; margin-bottom: 10px;';
	eids.forEach((entityId, index) => {
		const option = document.createElement('option');
		option.value = String(index);
		option.textContent = `#${formatValue(entityId)} (${(groups.get(entityId)?.length ?? 0)} facts)`;
		option.selected = index === selectedEntityIndex;
		select.appendChild(option);
	});
	select.addEventListener('change', () => {
		selectedEntityIndex = Number(select.value);
		renderActiveTab();
	});

	content.appendChild(select);
	appendNode(content, renderEntityView(facts, eid));
}

function renderTimelineTab(content: HTMLElement): void {
	appendNode(content, renderTimeline(controller.getTransactions(), controller.getFacts()));
}

function renderDiffResult(container: HTMLElement): void {
	container.textContent = '';
	const diff = controller.getLastDiff();
	if (diff === null) {
		appendNode(container, renderNotice('pick a transaction range and press "Show Diff"'));
		return;
	}
	appendNode(container, renderDiff(diff));
}

function getDiffConsole(): { root: HTMLElement; txA: HTMLInputElement; txB: HTMLInputElement; results: HTMLElement } {
	if (diffConsole !== null) {
		return diffConsole;
	}

	const root = document.createElement('div');
	const row = document.createElement('div');
	row.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 10px; font-size: 12px;';

	const txA = document.createElement('input');
	txA.type = 'number';
	txA.min = '1';
	txA.placeholder = 'txA';

	const txB = document.createElement('input');
	txB.type = 'number';
	txB.min = '1';
	txB.placeholder = 'txB';

	const results = document.createElement('div');

	const run = document.createElement('button');
	run.type = 'button';
	run.textContent = 'Show Diff';
	run.addEventListener('click', () => {
		const a = Number(txA.value);
		const b = Number(txB.value);
		if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1) {
			results.textContent = '';
			appendNode(results, renderNotice('enter valid tx numbers'));
			return;
		}
		controller.getDiff(a, b);
		renderDiffResult(results);
	});

	row.appendChild(document.createTextNode('diff'));
	row.appendChild(txA);
	row.appendChild(document.createTextNode('→'));
	row.appendChild(txB);
	row.appendChild(run);

	root.appendChild(row);
	root.appendChild(results);

	diffConsole = { root, txA, txB, results };
	return diffConsole;
}

function renderDiffTab(content: HTMLElement): void {
	const transactions = controller.getTransactions();
	const console = getDiffConsole();

	if (console.txA.value === '' && console.txB.value === '' && transactions.length >= 2) {
		console.txA.value = String(transactions[transactions.length - 2][0]);
		console.txB.value = String(transactions[transactions.length - 1][0]);
		controller.getDiff(Number(console.txA.value), Number(console.txB.value));
	}

	renderDiffResult(console.results);
	content.appendChild(console.root);
}

function getQueryConsole(): { root: HTMLElement; input: HTMLTextAreaElement; error: HTMLElement; results: HTMLElement } {
	if (queryConsole !== null) {
		return queryConsole;
	}

	const root = document.createElement('div');

	const input = document.createElement('textarea');
	input.rows = 5;
	input.spellcheck = false;
	input.value = JSON.stringify(
		{
			find: ['?e', '?name'],
			where: [['?e', 'user/name', '?name']]
		},
		null,
		2
	);

	const row = document.createElement('div');
	row.style.cssText = 'display: flex; gap: 8px; margin: 8px 0;';

	const error = document.createElement('div');
	error.style.cssText = 'color: #b91c1c; font-size: 12px; margin-bottom: 8px; white-space: pre-wrap;';

	const results = document.createElement('div');

	const run = document.createElement('button');
	run.type = 'button';
	run.textContent = 'Run Query';
	run.addEventListener('click', () => {
		let spec: QuerySpec;
		try {
			spec = JSON.parse(input.value) as QuerySpec;
		} catch {
			error.textContent = 'invalid query JSON';
			results.textContent = '';
			return;
		}

		controller.runQuery(spec);
		renderQueryResult(results);
	});

	row.appendChild(run);

	root.appendChild(input);
	root.appendChild(row);
	root.appendChild(error);
	root.appendChild(results);

	queryConsole = { root, input, error, results };
	return queryConsole;
}

function renderQueryResult(container: HTMLElement): void {
	container.textContent = '';

	const queryError = controller.getLastQueryError();
	const consoleError = getQueryConsole().error;
	consoleError.textContent = queryError ?? '';

	const rows = controller.getLastQueryRows();
	if (rows === null) {
		return;
	}

	appendNode(container, renderQueryResults(rows, controller.getLastQuerySpec()?.find));
}

function renderQueryTab(content: HTMLElement): void {
	const console = getQueryConsole();
	renderQueryResult(console.results);
	content.appendChild(console.root);
}

let timeTravelConsole: {
	root: HTMLElement;
	slider: HTMLInputElement;
	numberInput: HTMLInputElement;
	reset: HTMLButtonElement;
	summary: HTMLElement;
	diff: HTMLElement;
} | null = null;

function getTimeTravelConsole(): {
	root: HTMLElement;
	slider: HTMLInputElement;
	numberInput: HTMLInputElement;
	reset: HTMLButtonElement;
	summary: HTMLElement;
	diff: HTMLElement;
} {
	if (timeTravelConsole !== null) {
		return timeTravelConsole;
	}

	const root = document.createElement('div');
	root.style.cssText = 'display: flex; flex-direction: column; gap: 10px; font-size: 12px;';

	const row = document.createElement('div');
	row.style.cssText = 'display: flex; align-items: center; gap: 8px;';

	const slider = document.createElement('input');
	slider.type = 'range';
	slider.min = '1';
	slider.max = '1';
	slider.value = '1';
	slider.style.cssText = 'flex: 1;';
	slider.addEventListener('input', () => {
		controller.setTimeTravelTx(Number(slider.value));
	});

	const numberInput = document.createElement('input');
	numberInput.type = 'number';
	numberInput.min = '1';
	numberInput.style.cssText = 'width: 72px;';
	numberInput.addEventListener('change', () => {
		controller.setTimeTravelTx(Number(numberInput.value));
	});

	const reset = document.createElement('button');
	reset.type = 'button';
	reset.textContent = 'Latest';
	reset.addEventListener('click', () => {
		controller.setTimeTravelTx(null);
	});

	row.appendChild(document.createTextNode('at tx'));
	row.appendChild(slider);
	row.appendChild(numberInput);
	row.appendChild(reset);

	const summary = document.createElement('div');
	summary.style.cssText = 'color: #334155;';

	const diff = document.createElement('div');

	root.appendChild(row);
	root.appendChild(summary);
	root.appendChild(diff);

	timeTravelConsole = { root, slider, numberInput, reset, summary, diff };
	return timeTravelConsole;
}

function renderTimeTravelTab(content: HTMLElement): void {
	const transactions = controller.getTransactions();
	if (transactions.length === 0) {
		appendNode(content, renderNotice('no transactions yet; nothing to time travel over'));
		return;
	}

	const maxTx = transactions[transactions.length - 1][0];
	const pinned = controller.getTimeTravelTx();
	const selected = pinned ?? maxTx;
	const console = getTimeTravelConsole();

	console.slider.max = String(maxTx);
	console.numberInput.max = String(maxTx);
	console.slider.value = String(selected);
	console.numberInput.value = String(selected);

	const facts = controller.getFacts();
	const entityCount = new Set(facts.map((fact) => fact[0])).size;
	console.summary.textContent = pinned === null
		? `viewing latest state (tx ${maxTx}) — ${facts.length} facts, ${entityCount} entities`
		: `pinned at tx ${pinned} of ${maxTx} — ${facts.length} facts, ${entityCount} entities`;

	console.diff.textContent = '';
	const stepDiff = controller.getTimeTravelDiff(selected);
	if (stepDiff === null || (stepDiff.added.length === 0 && stepDiff.retracted.length === 0)) {
		appendNode(console.diff, renderNotice('no changes in this transaction'));
	} else {
		appendNode(console.diff, renderDiff(stepDiff));
	}

	content.appendChild(console.root);
}

function renderGraphTab(content: HTMLElement): void {
	const model = buildGraphModel(controller.getFacts(), controller.getSchemas());
	if (model.nodes.length === 0) {
		appendNode(content, renderNotice('no entities to graph yet'));
		return;
	}

	const layout = layoutGraph(model, { width: 640, height: 460 });
	appendNode(content, renderGraphSvg(model, layout));

	const pinned = controller.getTimeTravelTx();
	const summary = document.createElement('div');
	summary.style.cssText = 'color: #64748b; font-size: 12px; margin-top: 8px;';
	summary.textContent = `${model.nodes.length} nodes · ${model.edges.length} edges${pinned === null ? '' : ` (at tx ${pinned})`} — ref attributes only; deterministic circle layout`;
	content.appendChild(summary);
}

function renderActiveTab(): void {
	const content = document.getElementById('panel-content');
	if (!content) {
		return;
	}

	content.textContent = '';

	if (!controller.hasSnapshot()) {
		appendNode(content, renderNotice(controller.getLastError() ?? 'waiting for snapshot'));
		return;
	}

	switch (controller.getActiveTab()) {
		case 'facts':
			renderFactsTab(content);
			break;
		case 'entities':
			renderEntitiesTab(content);
			break;
		case 'timeline':
			renderTimelineTab(content);
			break;
		case 'diff':
			renderDiffTab(content);
			break;
		case 'query':
			renderQueryTab(content);
			break;
		case 'time-travel':
			renderTimeTravelTab(content);
			break;
		case 'graph':
			renderGraphTab(content);
			break;
	}
}

function initTabBar(): void {
	for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('#tab-bar .tab'))) {
		button.addEventListener('click', () => {
			const tab = button.dataset['tab'] as DevtoolsTabId | undefined;
			if (tab !== undefined) {
				controller.setActiveTab(tab);
			}
		});
	}
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

	for (const tab of TABS) {
		controller.setRenderCallback(tab, () => {
			renderActiveTab();
			updateTabBar();
		});
	}
	initTabBar();

	const port = chromeApi.runtime.connect({ name: 'fatos-devtools-panel' });

	port.onMessage?.addListener((message: unknown) => {
		if (!isPanelStateMessage(message)) {
			return;
		}

		renderState(message.state);

		const latest = message.state.latestEvent;
		if (latest?.kind === 'snapshot') {
			controller.setSnapshot(latest.payload as FactSnapshot);
		}
	});

	port.onDisconnect?.addListener(() => {
		setText('status', 'disconnected');
	});

	const inspectButton = document.getElementById('inspect-btn');
	inspectButton?.addEventListener('click', () => {
		port.postMessage({ type: 'fatos:panel-request-inspect' });
	});

	const exportButton = document.getElementById('export-btn');
	exportButton?.addEventListener('click', () => {
		const snapshot = controller.getSnapshot();
		if (snapshot === null) {
			setText('status', 'no snapshot to export');
			return;
		}

		downloadSnapshot(snapshot);
		setText('status', 'snapshot exported');
	});

	const importButton = document.getElementById('import-btn');
	importButton?.addEventListener('click', () => {
		pickSnapshotFile()
			.then((snapshot) => {
				if (snapshot === null) {
					return; // picker cancelled
				}

				if (controller.importSnapshot(serializeSnapshot(snapshot))) {
					setText('status', 'snapshot imported');
					renderActiveTab();
					updateTabBar();
				} else {
					setText('status', `import failed: ${controller.getLastError() ?? 'unknown error'}`);
				}
			})
			.catch((error) => {
				setText('status', `import failed: ${error instanceof Error ? error.message : String(error)}`);
			});
	});

	renderActiveTab();
	updateTabBar();
	setText('status', 'connecting...');
	port.postMessage({ type: 'fatos:panel-init', tabId });
}

initPanelUi();

export {};
