import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Fact, TransactionRecord } from '@fatos/client';
import {
	renderDiff,
	renderEntityView,
	renderFactTable,
	renderNotice,
	renderQueryResults,
	renderTimeline
} from './render';

type FakeElement = {
	tagName: string;
	style: Record<string, string>;
	children: FakeElement[];
	textContent: string | null;
	colSpan: number;
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
			colSpan: 1,
			setAttribute: vi.fn(),
			appendChild(child: FakeElement) {
				this.children.push(child);
			}
		};
	}

	return {
		createElement: (tag: string) => makeElement(tag)
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

const facts: Fact[] = [
	[1, 'name', 'Alice', 1, 'add'],
	[1, 'age', 30, 2, 'add'],
	[1, 'age', 30, 3, 'retract']
];

const transactions: TransactionRecord[] = [
	[1, 1000, { source: 'ui' }],
	[2, 2000, null]
];

function textOf(element: FakeElement): string[] {
	return element.children.map((child) => child.textContent ?? '');
}

afterEach(() => {
	Reflect.deleteProperty(globalThis, 'document');
});

describe('render helpers (guarded)', () => {
	it('returns null when document is unavailable', () => {
		Reflect.deleteProperty(globalThis, 'document');
		expect(renderFactTable(facts)).toBeNull();
		expect(renderEntityView(facts, 1)).toBeNull();
		expect(renderTimeline(transactions, facts)).toBeNull();
		expect(renderDiff({ added: [], retracted: [] })).toBeNull();
		expect(renderQueryResults([])).toBeNull();
		expect(renderNotice('waiting')).toBeNull();
	});
});

describe('renderFactTable', () => {
	it('renders one row per fact with formatted cells', () => {
		withDocument(() => {
			const table = renderFactTable(facts) as unknown as FakeElement;
			expect(table.tagName).toBe('table');
			const tbody = table.children.find((child) => child.tagName === 'tbody');
			expect(tbody?.children).toHaveLength(3);

			const firstRow = tbody?.children[0] as FakeElement;
			expect(textOf(firstRow)).toEqual(['1', 'name', 'Alice', '1', 'add']);
			expect(textOf(tbody?.children[2] as FakeElement)).toEqual(['1', 'age', '30', '3', 'retract']);
		});
	});

	it('renders an empty-state row for no facts', () => {
		withDocument(() => {
			const table = renderFactTable([]) as unknown as FakeElement;
			const tbody = table.children.find((child) => child.tagName === 'tbody');
			expect(textOf(tbody?.children[0] as FakeElement)).toEqual(['no facts']);
		});
	});
});

describe('renderEntityView', () => {
	it('shows the entity header and only its facts', () => {
		withDocument(() => {
			const view = renderEntityView(facts, 1) as unknown as FakeElement;
			expect(view.children[0].textContent).toContain('entity #1');
			expect(view.children[0].textContent).toContain('3 facts');
			const table = view.children[1] as unknown as FakeElement;
			const tbody = table.children.find((child) => child.tagName === 'tbody');
			expect(tbody?.children).toHaveLength(3);
		});
	});
});

describe('renderTimeline', () => {
	it('renders one entry per transaction with fact counts', () => {
		withDocument(() => {
			const view = renderTimeline(transactions, facts) as unknown as FakeElement;
			const list = view.children[0] as FakeElement;
			expect(list.children).toHaveLength(2);

			const first = list.children[0] as FakeElement;
			expect(textOf(first)).toContain('tx 1');
			expect(textOf(first)).toContain('1 facts');
			expect(textOf(first)).toContain('{"source":"ui"}');

			const second = list.children[1] as FakeElement;
			expect(textOf(second)).toContain('tx 2');
			expect(textOf(second)).toContain('1 facts');
		});
	});

	it('renders an empty state without transactions', () => {
		withDocument(() => {
			const view = renderTimeline([]) as unknown as FakeElement;
			expect(view.children[0].textContent).toContain('no transactions');
		});
	});
});

describe('renderDiff', () => {
	it('renders added and retracted sections', () => {
		withDocument(() => {
			const diff = {
				added: [[1, 'name', 'Alicia', 4, 'add'] as Fact],
				retracted: [[1, 'name', 'Alice', 3, 'retract'] as Fact]
			};
			const view = renderDiff(diff) as unknown as FakeElement;
			expect(view.children[0].textContent).toContain('added (1)');
			expect(view.children[2].textContent).toContain('retracted (1)');
		});
	});

	it('renders a no-changes notice for an empty diff', () => {
		withDocument(() => {
			const view = renderDiff({ added: [], retracted: [] }) as unknown as FakeElement;
			expect(view.children[0].textContent).toContain('no changes');
		});
	});
});

describe('renderQueryResults', () => {
	it('uses find column names as headers', () => {
		withDocument(() => {
			const rows = [
				[1, 'Alice'],
				[2, 'Bob']
			];
			const table = renderQueryResults(rows, ['?e', '?name']) as unknown as FakeElement;
			const headRow = table.children[0].children[0] as FakeElement;
			expect(textOf(headRow)).toEqual(['?e', '?name']);

			const tbody = table.children[1] as FakeElement;
			expect(textOf(tbody.children[0] as FakeElement)).toEqual(['1', 'Alice']);
		});
	});

	it('renders a no-results row', () => {
		withDocument(() => {
			const table = renderQueryResults([]) as unknown as FakeElement;
			const cell = table.children[0].children[0].children[0] as FakeElement;
			expect(textOf(cell)).toEqual(['no results']);
		});
	});
});

describe('renderNotice', () => {
	it('renders the message text', () => {
		withDocument(() => {
			const notice = renderNotice('waiting for snapshot') as unknown as FakeElement;
			expect(notice.textContent).toBe('waiting for snapshot');
		});
	});
});

