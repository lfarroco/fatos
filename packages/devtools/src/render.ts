/**
 * DOM render helpers for the DevTools inspector (design/04 P4).
 *
 * Every helper is guarded: when `document` is unavailable (node / SSR / test
 * environments) they return `null`. All user data is written through
 * `textContent` — never `innerHTML` — so fact values are never interpreted as
 * markup. Inline styles keep the monospace/light aesthetic used across the
 * extension panel (ink #0f172a on #f8fafc, slate borders, 12px mono).
 */

import type { EntityId, Fact, QueryTerm, TransactionRecord } from '@fatos/client';
import type { DiffResult } from '@fatos/core';
import { computeTimeline, formatValue } from './transforms';
import type { GraphLayout, GraphModel } from './graph';

type Style = Partial<CSSStyleDeclaration>;

const tableStyle: Style = {
	width: '100%',
	borderCollapse: 'collapse',
	fontSize: '12px',
	lineHeight: '1.45'
};

const thStyle: Style = {
	textAlign: 'left',
	padding: '6px 8px',
	borderBottom: '2px solid #cbd5e1',
	color: '#334155',
	fontWeight: '600'
};

const tdStyle: Style = {
	padding: '6px 8px',
	borderBottom: '1px solid #e2e8f0',
	verticalAlign: 'top'
};

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	style?: Style,
	text?: string
): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	if (style !== undefined) {
		Object.assign(element.style, style);
	}
	if (text !== undefined) {
		element.textContent = text;
	}
	return element;
}

function factTable(facts: readonly Fact[]): HTMLTableElement {
	const table = el('table', tableStyle);
	const head = el('thead');
	const headRow = el('tr');
	for (const label of ['eid', 'attribute', 'value', 'tx', 'op']) {
		headRow.appendChild(el('th', thStyle, label));
	}
	head.appendChild(headRow);
	table.appendChild(head);

	const body = el('tbody');
	if (facts.length === 0) {
		const row = el('tr');
		const cell = el('td', { ...tdStyle, color: '#94a3b8', fontStyle: 'italic' }, 'no facts');
		cell.colSpan = 5;
		row.appendChild(cell);
		body.appendChild(row);
	} else {
		for (const [eid, attribute, value, tx, op] of facts) {
			const row = el('tr');
			const isRetract = op === 'retract';
			const cellStyle: Style = isRetract
				? { ...tdStyle, color: '#64748b' }
				: tdStyle;
			const valueStyle: Style = isRetract
				? { ...tdStyle, color: '#b91c1c', textDecoration: 'line-through' }
				: tdStyle;

			row.appendChild(el('td', cellStyle, formatValue(eid)));
			row.appendChild(el('td', cellStyle, attribute));
			row.appendChild(el('td', valueStyle, formatValue(value)));
			row.appendChild(el('td', cellStyle, String(tx)));
			row.appendChild(el('td', cellStyle, op));
			body.appendChild(row);
		}
	}
	table.appendChild(body);
	return table;
}

/**
 * Renders the fact log as a table (eid | attribute | value | tx | op).
 * Retracted facts are muted with a struck-through value.
 */
export function renderFactTable(facts: readonly Fact[]): HTMLTableElement | null {
	if (typeof document === 'undefined') {
		return null;
	}
	return factTable(facts);
}

/**
 * Renders the facts of a single entity: a header (entity id + fact count)
 * followed by the fact table for that entity.
 */
export function renderEntityView(facts: readonly Fact[], eid: EntityId): HTMLElement | null {
	if (typeof document === 'undefined') {
		return null;
	}

	const entityFacts = facts.filter((fact) => fact[0] === eid);
	const container = el('div');
	const header = el(
		'div',
		{
			fontSize: '13px',
			fontWeight: '600',
			marginBottom: '8px',
			color: '#0f172a'
		},
		`entity #${formatValue(eid)} — ${entityFacts.length} facts`
	);
	container.appendChild(header);
	container.appendChild(factTable(entityFacts));
	return container;
}


/**
 * Renders the transaction ledger as a timeline: one entry per transaction
 * with tx number, timestamp, fact count, and metadata. Pass the fact log as
 * the second argument to get real fact counts.
 */
export function renderTimeline(
	transactions: readonly TransactionRecord[],
	facts: readonly Fact[] = []
): HTMLElement | null {
	if (typeof document === 'undefined') {
		return null;
	}

	const container = el('div');
	if (transactions.length === 0) {
		container.appendChild(
			el('div', { color: '#94a3b8', fontStyle: 'italic', fontSize: '12px', padding: '8px' }, 'no transactions yet')
		);
		return container;
	}

	const list = el('ol', {
		listStyle: 'none',
		margin: '0',
		padding: '0',
		display: 'flex',
		flexDirection: 'column',
		gap: '6px'
	});

	for (const entry of computeTimeline(transactions, facts)) {
		const item = el('li', {
			display: 'flex',
			alignItems: 'baseline',
			gap: '10px',
			padding: '8px 10px',
			border: '1px solid #e2e8f0',
			borderRadius: '6px',
			background: '#ffffff',
			fontSize: '12px'
		});

		item.appendChild(el('span', { fontWeight: '600', color: '#0f172a', minWidth: '34px' }, `tx ${entry.tx}`));
		item.appendChild(
			el('span', { color: '#334155', minWidth: '150px' }, new Date(entry.timestamp).toLocaleString())
		);
		item.appendChild(
			el('span', {
				color: '#0369a1',
				background: '#e0f2fe',
				borderRadius: '999px',
				padding: '1px 8px',
				fontSize: '11px'
			}, `${entry.factCount} facts`)
		);

		if (entry.metadata !== null) {
			item.appendChild(
				el('span', { color: '#64748b', overflowWrap: 'anywhere' }, JSON.stringify(entry.metadata))
			);
		}

		list.appendChild(item);
	}

	container.appendChild(list);
	return container;
}

/**
 * Renders a diff result: an "added" section and a "retracted" section, each
 * with its own fact table, or a no-changes notice.
 */
export function renderDiff(diff: DiffResult): HTMLElement | null {
	if (typeof document === 'undefined') {
		return null;
	}

	const container = el('div');
	if (diff.added.length === 0 && diff.retracted.length === 0) {
		container.appendChild(
			el('div', { color: '#94a3b8', fontStyle: 'italic', fontSize: '12px', padding: '8px' }, 'no changes')
		);
		return container;
	}

	if (diff.added.length > 0) {
		container.appendChild(
			el('div', { fontSize: '12px', fontWeight: '600', color: '#047857', margin: '8px 0 6px' }, `added (${diff.added.length})`)
		);
		container.appendChild(factTable(diff.added));
	}

	if (diff.retracted.length > 0) {
		container.appendChild(
			el('div', { fontSize: '12px', fontWeight: '600', color: '#b91c1c', margin: '12px 0 6px' }, `retracted (${diff.retracted.length})`)
		);
		container.appendChild(factTable(diff.retracted));
	}

	return container;
}

/**
 * Renders query result rows (positional `QueryTerm[][]`) as a table. Pass the
 * spec's `find` variable names as `columns` for meaningful headers; otherwise
 * columns are numbered.
 */
export function renderQueryResults(
	rows: readonly (readonly QueryTerm[])[],
	columns?: readonly string[]
): HTMLElement | null {
	if (typeof document === 'undefined') {
		return null;
	}

	const table = el('table', tableStyle);
	const head = el('thead');
	const headRow = el('tr');
	const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
	const count = Math.max(width, columns?.length ?? 0);

	if (count === 0) {
		const row = el('tr');
		const cell = el('td', { ...tdStyle, color: '#94a3b8', fontStyle: 'italic' }, 'no results');
		cell.colSpan = 1;
		row.appendChild(cell);
		headRow.appendChild(row);
		head.appendChild(headRow);
		table.appendChild(head);
		return table;
	}

	for (let index = 0; index < count; index += 1) {
		headRow.appendChild(el('th', thStyle, columns?.[index] ?? `col ${index + 1}`));
	}
	head.appendChild(headRow);
	table.appendChild(head);

	const body = el('tbody');
	for (const row of rows) {
		const tr = el('tr');
		for (let index = 0; index < count; index += 1) {
			tr.appendChild(el('td', tdStyle, formatValue(row[index])));
		}
		body.appendChild(tr);
	}
	table.appendChild(body);
	return table;
}

/**
 * Renders a muted informational notice (used for "waiting for snapshot",
 * "no snapshot", etc.).
 */
export function renderNotice(message: string): HTMLElement | null {
	if (typeof document === 'undefined') {
		return null;
	}

	return el('div', {
		color: '#64748b',
		fontStyle: 'italic',
		fontSize: '12px',
		padding: '16px 8px'
	}, message);
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/**
 * Renders the graph model as an inline SVG (Phase 6 graph tab): straight-line
 * edges labeled with the attribute name, nodes as filled circles with text
 * labels. Deterministic — positions come from {@link layoutGraph}, so the
 * same model always draws the same picture. Document-guarded: returns `null`
 * when `document` is unavailable.
 */
export function renderGraphSvg(model: GraphModel, layout: GraphLayout): SVGElement | null {
	if (typeof document === 'undefined') {
		return null;
	}

	const svg = document.createElementNS(SVG_NAMESPACE, 'svg') as SVGElement;
	svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
	svg.setAttribute('width', '100%');
	svg.setAttribute('height', String(layout.height));
	svg.style.display = 'block';
	svg.style.background = '#ffffff';
	svg.style.border = '1px solid #e2e8f0';
	svg.style.borderRadius = '6px';
	svg.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace';

	for (const edge of model.edges) {
		const from = layout.positions.get(edge.from);
		const to = layout.positions.get(edge.to);
		if (from === undefined || to === undefined) {
			continue;
		}

		const line = document.createElementNS(SVG_NAMESPACE, 'line');
		line.setAttribute('x1', String(from.x));
		line.setAttribute('y1', String(from.y));
		line.setAttribute('x2', String(to.x));
		line.setAttribute('y2', String(to.y));
		line.setAttribute('stroke', '#94a3b8');
		line.setAttribute('stroke-width', '1.5');
		svg.appendChild(line);

		const label = document.createElementNS(SVG_NAMESPACE, 'text');
		label.setAttribute('x', String((from.x + to.x) / 2));
		label.setAttribute('y', String((from.y + to.y) / 2 - 4));
		label.setAttribute('text-anchor', 'middle');
		label.setAttribute('fill', '#64748b');
		label.setAttribute('font-size', '10');
		label.textContent = edge.attribute;
		svg.appendChild(label);
	}

	for (const node of model.nodes) {
		const position = layout.positions.get(node.id);
		if (position === undefined) {
			continue;
		}

		const circle = document.createElementNS(SVG_NAMESPACE, 'circle');
		circle.setAttribute('cx', String(position.x));
		circle.setAttribute('cy', String(position.y));
		circle.setAttribute('r', '6');
		circle.setAttribute('fill', '#0f172a');
		svg.appendChild(circle);

		const label = document.createElementNS(SVG_NAMESPACE, 'text');
		label.setAttribute('x', String(position.x + 10));
		label.setAttribute('y', String(position.y + 4));
		label.setAttribute('fill', '#0f172a');
		label.setAttribute('font-size', '11');
		label.textContent = node.label;
		svg.appendChild(label);
	}

	return svg;
}
