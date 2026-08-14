import { describe, expect, it, vi } from 'vitest';
import { lookupRef, ref } from '@fatos/core';
import type { Fact } from '@fatos/client';
import { buildGraphModel, layoutGraph } from './graph';
import { renderGraphSvg } from './render';

type FakeElement = {
	tagName: string;
	style: Record<string, string>;
	children: FakeElement[];
	textContent: string | null;
	setAttribute: ReturnType<typeof vi.fn>;
	appendChild: (child: FakeElement) => void;
};

function createFakeDocument(): Document {
	function makeElement(tag: string): FakeElement {
		return {
			tagName: tag,
			style: {},
			children: [],
			textContent: null,
			setAttribute: vi.fn(),
			appendChild(child: FakeElement) {
				this.children.push(child);
			}
		};
	}

	return {
		createElement: (tag: string) => makeElement(tag),
		createElementNS: (_namespace: string, tag: string) => makeElement(tag)
	} as unknown as Document;
}

function withDocument(block: () => void): void {
	const original = globalThis.document;
	Object.defineProperty(globalThis, 'document', {
		value: createFakeDocument(),
		configurable: true
	});
	try {
		block();
	} finally {
		if (original === undefined) {
			Reflect.deleteProperty(globalThis, 'document');
		} else {
			Object.defineProperty(globalThis, 'document', { value: original, configurable: true });
		}
	}
}

describe('buildGraphModel', () => {
	it('creates nodes from entities and edges from ref() values', () => {
		const facts: Fact[] = [
			[1, 'user/name', 'Alice', 1, 'add'],
			[2, 'user/name', 'Bob', 1, 'add'],
			[1, 'user/manager', ref(2), 2, 'add'],
			[-1, 'db/ident', 'user/name', 1, 'add'] // schema entity is skipped
		];

		const model = buildGraphModel(facts);
		expect(model.nodes.map((node) => node.id)).toEqual([1, 2]);
		expect(model.nodes[0].label).toBe('Alice');
		expect(model.edges).toEqual([{ from: 1, to: 2, attribute: 'user/manager' }]);
	});

	it('treats a plain known entity id on a ref schema attribute as an edge', () => {
		const facts: Fact[] = [
			[1, 'post/author', 2, 1, 'add'],
			[2, 'user/name', 'Bob', 1, 'add']
		];
		const schemas = [{ eid: -1, ident: 'post/author', valueType: 'ref', cardinality: 'one' }];

		const model = buildGraphModel(facts, schemas);
		expect(model.edges).toEqual([{ from: 1, to: 2, attribute: 'post/author' }]);
	});

	it('does not edge a plain id when the attribute is not ref-typed', () => {
		const facts: Fact[] = [
			[1, 'user/score', 2, 1, 'add'],
			[2, 'user/name', 'Bob', 1, 'add']
		];

		const model = buildGraphModel(facts);
		expect(model.edges).toEqual([]);
		expect(model.nodes).toHaveLength(2);
	});

	it('drops edges to unknown targets and lookupRef values', () => {
		const facts: Fact[] = [
			[1, 'user/manager', ref(99), 1, 'add'], // 99 has no facts -> no node
			[1, 'user/org', ref(lookupRef(['org/name', 'Acme'])), 1, 'add'] // unresolvable -> skipped
		];

		const model = buildGraphModel(facts);
		expect(model.nodes).toHaveLength(1);
		expect(model.edges).toEqual([]);
	});

	it('deduplicates repeated edges and ignores retracted refs', () => {
		const facts: Fact[] = [
			[2, 'user/name', 'Bob', 1, 'add'],
			[1, 'user/manager', ref(2), 1, 'add'],
			[1, 'user/manager', ref(2), 2, 'add'],
			[1, 'user/manager', ref(3), 3, 'retract']
		];

		const model = buildGraphModel(facts);
		expect(model.edges).toEqual([{ from: 1, to: 2, attribute: 'user/manager' }]);
	});

	it('uses a name-like attribute as the label, falling back to the id', () => {
		const facts: Fact[] = [
			[1, 'user/name', 'Alice', 1, 'add'],
			[1, 'user/name', 'Alicia', 2, 'add'],
			[2, 'user/role', 'admin', 1, 'add']
		];

		const model = buildGraphModel(facts);
		expect(model.nodes[0].label).toBe('Alicia'); // last add wins
		expect(model.nodes[1].label).toBe('#2');
	});
});

describe('layoutGraph', () => {
	it('places nodes deterministically on a circle', () => {
		const model = buildGraphModel([
			[1, 'a', 'x', 1, 'add'],
			[2, 'b', 'y', 1, 'add'],
			[3, 'c', 'z', 1, 'add']
		]);
		const layout = layoutGraph(model, { width: 600, height: 400, margin: 40 });
		expect(layout.width).toBe(600);
		expect(layout.height).toBe(400);
		expect(layout.positions.size).toBe(3);

		const again = layoutGraph(model, { width: 600, height: 400, margin: 40 });
		expect([...layout.positions.values()]).toEqual([...again.positions.values()]);

		// All positions sit on the same circle radius around the center.
		const centerX = 300;
		const centerY = 200;
		const radius = Math.min(600, 400) / 2 - 40;
		const distances = [...layout.positions.values()].map(({ x, y }) =>
			Math.round(Math.hypot(x - centerX, y - centerY))
		);
		expect(new Set(distances)).toEqual(new Set([Math.round(radius)]));
	});

	it('centers a single node', () => {
		const model = buildGraphModel([[1, 'a', 'x', 1, 'add']]);
		const layout = layoutGraph(model);
		expect(layout.positions.get(1)).toEqual({ x: 300, y: 210 });
	});
});

describe('renderGraphSvg', () => {
	it('returns null without a document', () => {
		Reflect.deleteProperty(globalThis, 'document');
		const model = buildGraphModel([]);
		expect(renderGraphSvg(model, layoutGraph(model))).toBeNull();
	});

	it('draws one line per edge and one circle per node', () => {
		withDocument(() => {
			const model = buildGraphModel([
				[1, 'user/name', 'Alice', 1, 'add'],
				[2, 'user/name', 'Bob', 1, 'add'],
				[1, 'user/manager', ref(2), 2, 'add']
			]);
			const svg = renderGraphSvg(model, layoutGraph(model)) as unknown as FakeElement;
			expect(svg.tagName).toBe('svg');
			expect(svg.setAttribute).toHaveBeenCalledWith('viewBox', '0 0 600 420');
			expect(svg.children.filter((child) => child.tagName === 'line')).toHaveLength(1);
			expect(svg.children.filter((child) => child.tagName === 'circle')).toHaveLength(2);
			expect(svg.children.filter((child) => child.tagName === 'text')).toHaveLength(3);
		});
	});
});
