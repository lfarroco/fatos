/**
 * Browser harness — a small demo page that publishes live `FactSnapshot`s to
 * the Fatos DevTools panel (design/04 P4).
 *
 * `browser-harness.html` loads the built bundle of this module, which mounts
 * the harness into `#fatos-browser-harness`: it seeds a demo client, installs
 * the snapshot publisher (@fatos/devtools), and re-publishes on every write,
 * so the panel shows live facts, transactions, and diffs as you click.
 *
 * The module is safe to import in Node (tests, CLI): mounting only happens
 * when a DOM mount point is present.
 */
import { createClient } from '@fatos/client';
import type { FatosClient } from '@fatos/client';
import { installSnapshotPublisher } from '@fatos/devtools';
import type { SnapshotPublisher } from '@fatos/devtools';

export type BrowserHarness = {
	client: FatosClient;
	publisher: SnapshotPublisher;
	dispose: () => void;
};

/** Seeds the demo dataset used by the harness page. */
export function createDemoClient(): FatosClient {
	const client = createClient();
	client.add(1, 'user/name', 'Alice');
	client.add(1, 'user/role', 'admin');
	client.add(1, 'user/active', true);
	client.add(2, 'user/name', 'Bob');
	client.add(2, 'user/role', 'editor');
	client.add(3, 'order/status', 'placed');
	client.add(3, 'order/items', 3);
	return client;
}

function createButton(label: string, onClick: () => void): HTMLButtonElement {
	const button = document.createElement('button');
	button.type = 'button';
	button.textContent = label;
	button.style.cssText =
		'font: inherit; font-size: 12px; padding: 6px 10px; border: 1px solid #94a3b8; ' +
		'border-radius: 6px; background: #ffffff; color: #0f172a; cursor: pointer;';
	button.addEventListener('click', onClick);
	return button;
}

/**
 * Mounts the harness into the given element (or `#fatos-browser-harness`):
 * seeds the demo client, installs the snapshot publisher, and renders buttons
 * that transact so the DevTools panel can show live changes. Returns the
 * harness handle (`dispose()` tears the publisher and UI down).
 */
export function mountBrowserHarness(host?: HTMLElement): BrowserHarness {
	const root = host ?? document.getElementById('fatos-browser-harness');
	if (!root) {
		throw new Error('browser harness mount point (#fatos-browser-harness) not found');
	}

	const client = createDemoClient();

	const status = document.createElement('div');
	status.style.cssText = 'margin: 12px 0; font-size: 12px; color: #475569;';

	const state = document.createElement('pre');
	state.style.cssText =
		'margin: 0; padding: 12px; background: #f1f5f9; border: 1px solid #e2e8f0; ' +
		'border-radius: 6px; font-size: 12px; line-height: 1.5; overflow: auto;';

	const publisher = installSnapshotPublisher(client, {
		onSnapshot: (snapshot) => {
			const at = snapshot.capturedAt === undefined ? '?' : new Date(snapshot.capturedAt).toLocaleTimeString();
			status.textContent =
				`published ${snapshot.facts.length} facts / ${snapshot.transactions.length} transactions at ${at}`;
			state.textContent = JSON.stringify(snapshot, null, 2);
		}
	});

	const controls = document.createElement('div');
	controls.style.cssText = 'display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px;';

	let nextAge = 30;
	controls.appendChild(createButton('add fact (user/age)', () => {
		nextAge += 1;
		client.add(1, 'user/age', nextAge);
	}));
	controls.appendChild(createButton('toggle user/active', () => {
		const active = client.entity(1)?.['user/active'] === true;
		if (active) {
			client.retract(1, 'user/active', true);
		} else {
			client.add(1, 'user/active', true);
		}
	}));
	controls.appendChild(createButton('transact (order shipped)', () => {
		client.transact([[3, 'order/status', 'shipped']], { source: 'harness' });
	}));
	controls.appendChild(createButton('publish now', () => {
		publisher.publish();
	}));

	root.textContent = '';
	root.appendChild(controls);
	root.appendChild(status);
	root.appendChild(state);

	return {
		client,
		publisher,
		dispose: () => {
			publisher.dispose();
			root.textContent = '';
		}
	};
}

// Auto-mount when loaded from the harness page (the script tag sits at the end
// of <body>, so the mount point already exists). Importing this module from
// Node (tests/CLI) has no `document`, so nothing mounts there.
if (typeof document !== 'undefined' && document.getElementById('fatos-browser-harness') !== null) {
	mountBrowserHarness();
}