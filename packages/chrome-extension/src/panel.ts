/**
 * Chrome Extension DevTools panel script
 */

type ChromeLike = {
	devtools?: {
		inspectedWindow?: {
			tabId?: number;
		};
		panels?: {
			create: (title: string, iconPath: string, pagePath: string, callback: (panel: unknown) => void) => void;
		};
	};
};

function getChromeApi(): ChromeLike | undefined {
	return (globalThis as { chrome?: ChromeLike }).chrome;
}

function initDevtoolsPanel(): void {
	const chromeApi = getChromeApi();
	const panels = chromeApi?.devtools?.panels;
	if (!panels?.create) {
		return;
	}

	const tabId = chromeApi?.devtools?.inspectedWindow?.tabId;
	const panelPath = typeof tabId === 'number' ? `panel.html?tabId=${tabId}` : 'panel.html';

	panels.create('Fatos', '', panelPath, (_panel: unknown) => {
		// The panel page handles runtime communication directly.
	});
}

initDevtoolsPanel();

export {};
