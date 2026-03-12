/**
 * Chrome Extension DevTools panel script
 */

type ChromeLike = {
	devtools?: {
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

	panels.create('Fatos', '', 'panel.html', (_panel: unknown) => {
		// The panel page handles runtime communication directly.
	});
}

initDevtoolsPanel();

export {};
