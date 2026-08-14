/**
 * Pure graph model + deterministic layout for the DevTools graph tab
 * (Phase 6). No DOM, no side effects: `buildGraphModel` derives a
 * node/edge model from snapshot facts, `layoutGraph` places nodes on a
 * circle (deterministic — no force simulation, no new dependencies), and
 * {@link renderGraphSvg} (in render.ts) draws it as inline SVG.
 *
 * Model rules:
 * - **Nodes** are entities with at least one fact. Schema entities
 *   (negative eids) are internal and skipped.
 * - **Edges** come from ref-typed attribute facts: branded `ref()` values
 *   (target must be a known entity id), or — on a ref schema attribute
 *   (`valueType: 'ref'` / `ref: true`) — a plain value that is a known
 *   entity id. Lookup-ref targets cannot be resolved without a database and
 *   are skipped. Edges are labeled with the attribute name and deduplicated
 *   by (from, attribute, to).
 * - **Labels** use the active value of the entity's first name-like
 *   attribute (exactly `name`, or any attribute ending in `/name`),
 *   falling back to `#<id>`.
 */

import { isLookupRef, isRef, REF_BRAND } from '@fatos/core';
import type { EntityId, Fact, SchemaInfo } from '@fatos/client';
import { formatValue } from './transforms';

export type GraphNode = {
	id: EntityId;
	label: string;
};

export type GraphEdge = {
	from: EntityId;
	to: EntityId;
	attribute: string;
};

export type GraphModel = {
	nodes: GraphNode[];
	edges: GraphEdge[];
};

export type GraphLayout = {
	/** Deterministic circle positions keyed by entity id. */
	positions: Map<EntityId, { x: number; y: number }>;
	width: number;
	height: number;
};

function isSchemaEid(eid: EntityId): boolean {
	return typeof eid === 'number' && eid < 0;
}

function isNameLike(attribute: string): boolean {
	return attribute === 'name' || attribute.endsWith('/name');
}

function nodeSortKey(eid: EntityId): string {
	return `${typeof eid}:${String(eid)}`;
}

function edgeKey(edge: GraphEdge): string {
	return `${typeof edge.from}:${String(edge.from)}\u0000${edge.attribute}\u0000${typeof edge.to}:${String(edge.to)}`;
}

/**
 * Builds the node/edge model from a snapshot fact log (engine values) and an
 * optional schema list (client `getSchemas()`), used to recognize ref
 * attributes declared with a plain-value ref value. Order is deterministic:
 * nodes sorted by id key, edges in fact-log order (deduplicated).
 */
export function buildGraphModel(facts: readonly Fact[], schemas?: readonly SchemaInfo[]): GraphModel {
	const schemaByAttribute = new Map<string, SchemaInfo>();
	if (schemas !== undefined) {
		for (const schema of schemas) {
			schemaByAttribute.set(schema.ident, schema);
		}
	}

	const entitySet = new Set<EntityId>();
	for (const [eid] of facts) {
		if (!isSchemaEid(eid)) {
			entitySet.add(eid);
		}
	}

	// Active label tracking: last add wins per attribute (facts are ascending
	// by tx); the first name-like attribute seen per entity wins the label.
	const activeNames = new Map<EntityId, Map<string, string>>();
	const nameAttributeOrder = new Map<EntityId, string[]>();
	const edges: GraphEdge[] = [];
	const edgeKeys = new Set<string>();

	for (const [eid, attribute, value, , op] of facts) {
		if (isSchemaEid(eid)) {
			continue;
		}

		if (isNameLike(attribute)) {
			const values = activeNames.get(eid) ?? new Map<string, string>();
			if (op === 'add') {
				if (!values.has(attribute)) {
					const order = nameAttributeOrder.get(eid) ?? [];
					order.push(attribute);
					nameAttributeOrder.set(eid, order);
				}
				values.set(attribute, String(value));
			} else {
				values.delete(attribute);
			}
			activeNames.set(eid, values);
		}

		if (op !== 'add') {
			continue;
		}

		let target: EntityId | null = null;
		if (isRef(value)) {
			const refTarget = value[REF_BRAND];
			if (typeof refTarget === 'number' || typeof refTarget === 'string') {
				target = refTarget;
			}
		} else if (!isLookupRef(value)) {
			const schema = schemaByAttribute.get(attribute);
			const isRefAttribute = schema?.valueType === 'ref' || schema?.ref === true;
			if (isRefAttribute && (typeof value === 'number' || typeof value === 'string')) {
				target = value;
			}
		}

		if (target !== null && entitySet.has(target)) {
			const edge: GraphEdge = { from: eid, to: target, attribute };
			const key = edgeKey(edge);
			if (!edgeKeys.has(key)) {
				edgeKeys.add(key);
				edges.push(edge);
			}
		}
	}

	const nodes: GraphNode[] = [...entitySet].sort((left, right) => {
		const leftKey = nodeSortKey(left);
		const rightKey = nodeSortKey(right);
		return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
	}).map((id) => {
		const firstNameAttribute = nameAttributeOrder.get(id)?.[0];
		const label = firstNameAttribute !== undefined ? activeNames.get(id)?.get(firstNameAttribute) : undefined;
		return { id, label: label ?? `#${formatValue(id)}` };
	});

	return { nodes, edges };
}

/**
 * Deterministic circle layout: nodes sorted in model order are placed on a
 * circle centered in the viewport, starting at 12 o'clock and going clockwise.
 * A single node sits at the center. Returns positions plus the viewport size.
 */
export function layoutGraph(
	model: GraphModel,
	options: { width?: number; height?: number; margin?: number } = {}
): GraphLayout {
	const width = options.width ?? 600;
	const height = options.height ?? 420;
	const margin = options.margin ?? 40;
	const centerX = width / 2;
	const centerY = height / 2;
	const count = model.nodes.length;
	const radius = count <= 1 ? 0 : Math.min(width, height) / 2 - margin;

	const positions = new Map<EntityId, { x: number; y: number }>();
	model.nodes.forEach((node, index) => {
		const angle = count <= 1 ? -Math.PI / 2 : (index / count) * Math.PI * 2 - Math.PI / 2;
		positions.set(node.id, {
			x: Math.round((centerX + radius * Math.cos(angle)) * 10) / 10,
			y: Math.round((centerY + radius * Math.sin(angle)) * 10) / 10
		});
	});

	return { positions, width, height };
}
