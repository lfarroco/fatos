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
 * - Page-side snapshot publisher (bridge producer)
 */

import type { Fact, FatosClient } from '@fatos/client';
import { serializeValue } from '@fatos/core';
import type { FactSnapshot } from './snapshot';

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

export type SnapshotPublisherOptions = {
	/**
	 * Publish the client's current state immediately after installing
	 * (default `true`).
	 */
	publishInitial?: boolean;
	/** Called with every snapshot right before it is published (e.g. logging). */
	onSnapshot?: (snapshot: FactSnapshot) => void;
};

export type SnapshotPublisher = {
	/** Builds and publishes a snapshot of the client's current state. */
	publish(): FactSnapshot;
	/** Stops listening for writes and inspect requests; safe to call twice. */
	dispose(): void;
};

/** The inspected page URL, when running in a browser context. */
function currentPageUrl(): string | undefined {
	return typeof location === 'undefined' ? undefined : location.href;
}

/**
 * Page-side snapshot producer (design/04 P4). Subscribes to client writes
 * (`transaction:committed`) and to extension inspect requests, and publishes a
 * `FactSnapshot` — facts + transactions from the client (values serialized to
 * their JSON-wire form so symbol-branded refs survive `postMessage`/runtime
 * messaging), plus `capturedAt`/`url` — through the browser devtools bridge.
 *
 * Returns a handle with `publish()` for on-demand re-publishing and `dispose()`
 * to tear the subscriptions down. Guards for no-window environments (Node
 * tests, SSR): install, publish, and dispose all no-op without a window.
 */
export function installSnapshotPublisher(
	client: FatosClient,
	options: SnapshotPublisherOptions = {}
): SnapshotPublisher {
	const bridge = createBrowserDevtoolsBridge();
	const { publishInitial = true, onSnapshot } = options;
	let disposed = false;

	const buildSnapshot = (): FactSnapshot => ({
		facts: client.getFacts().map(
			(fact) => [fact[0], fact[1], serializeValue(fact[2]), fact[3], fact[4]] as Fact
		),
		transactions: [...client.getTransactions()],
		capturedAt: Date.now(),
		url: currentPageUrl()
	});

	const publish = (): FactSnapshot => {
		const snapshot = buildSnapshot();
		if (!disposed) {
			onSnapshot?.(snapshot);
			bridge.publishSnapshot(snapshot);
		}
		return snapshot;
	};

	const unsubscribe = client.subscribe(publish);
	const stopInspectionHandler = installInspectionRequestHandler(publish);

	if (publishInitial) {
		publish();
	}

	return {
		publish,
		dispose(): void {
			if (disposed) {
				return;
			}
			disposed = true;
			unsubscribe();
			stopInspectionHandler();
		}
	};
}

export type { FactSnapshot } from './snapshot';
export { isFactSnapshot } from './snapshot';

export type { TimelineEntry, FactFilter } from './transforms';
export {
	buildScopedSnapshot,
	computeDiff,
	computeTimeline,
	factsAtOrBefore,
	filterFacts,
	formatValue,
	groupFactsByEntity,
	stableValueKey,
	transactionsAtOrBefore
} from './transforms';

export {
	renderDiff,
	renderEntityView,
	renderFactTable,
	renderGraphSvg,
	renderNotice,
	renderQueryResults,
	renderTimeline
} from './render';

export { buildGraphModel, layoutGraph } from './graph';
export type { GraphEdge, GraphLayout, GraphModel, GraphNode } from './graph';

export { DevtoolsPanelController } from './controller';
export type { DevtoolsRenderCallback, DevtoolsTabId } from './controller';

export {
	SnapshotFormatError,
	createBrowserFileIo,
	defaultSnapshotFilename,
	deserializeSnapshot,
	downloadSnapshot,
	pickSnapshotFile,
	serializeSnapshot
} from './export-import';
export type { FileIo } from './export-import';

export type { DiffResult } from '@fatos/core';
export type { EntityId, Fact, FactDatabase, TransactionRecord } from '@fatos/client';
export type { QuerySpec, QueryTerm } from '@fatos/client';

