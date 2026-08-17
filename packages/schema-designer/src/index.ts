/**
 * @fatos/schema-designer
 *
 * Shared model, validation, and adapter helpers for a visual schema designer.
 */

import { isLookupRef, isRef, isTemp, LOOKUP_REF_BRAND, REF_BRAND, ref, type EntityId } from '@fatos/core';
import { defaultReferenceAttributeName } from './editor';

export const version = '0.0.1';

export type ValueType = 'string' | 'number' | 'boolean' | 'null' | 'date' | 'bigint' | 'ref' | 'unknown';
export type Cardinality = 'one' | 'many';

export type SchemaInfo = {
	eid: number;
	ident: string;
	valueType: ValueType;
	cardinality: Cardinality;
	unique?: 'identity' | 'value';
	ref?: boolean;
};

export type Mutation = readonly [
	op: 'add' | 'retract',
	eid: number,
	attribute: string,
	value: unknown
];

export type SchemaDeclaration = {
	ident: string;
	valueType: ValueType;
	cardinality: Cardinality;
};

export type TransactionEntry = Mutation | SchemaDeclaration;

export type SchemaDesignerPoint = {
	x: number;
	y: number;
};

export type SchemaDesignerAttribute = {
	id: string;
	name: string;
	valueType: ValueType;
	cardinality: Cardinality;
};

export type SchemaDesignerEntity = {
	id: string;
	name: string;
	position: SchemaDesignerPoint;
	attributes: SchemaDesignerAttribute[];
};

export type SchemaDesignerRelationship = {
	id: string;
	name: string;
	fromEntityId: string;
	toEntityId: string;
	fromCardinality: Cardinality;
	toCardinality: Cardinality;
	referenceAttributeName?: string;
};

export type SchemaDesignerEntityData = {
	eid: number;
	entityId: string;
	attributes: Record<string, unknown>;
};

export type SchemaDesignerDocument = {
	version: 1;
	schema: {
		name: string;
		entities: SchemaDesignerEntity[];
		relationships: SchemaDesignerRelationship[];
	};
	entitiesData: SchemaDesignerEntityData[];
	view: {
		pan: SchemaDesignerPoint;
		zoom: number;
	};
};

export type FatosJsonSnapshot = {
	schemas?: SchemaInfo[];
	entities?: Array<Record<string, unknown> & { id: number }>;
};

export class SchemaDesignerValidationError extends Error {
	readonly issues: string[];

	constructor(issues: string[]) {
		super(`Invalid schema designer document (${issues.length} issue${issues.length === 1 ? '' : 's'})`);
		this.name = 'SchemaDesignerValidationError';
		this.issues = issues;
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isValueType(value: unknown): value is ValueType {
	return (
		value === 'string' ||
		value === 'number' ||
		value === 'boolean' ||
		value === 'null' ||
		value === 'date' ||
		value === 'bigint' ||
		value === 'ref' ||
		value === 'unknown'
	);
}

function isCardinality(value: unknown): value is Cardinality {
	return value === 'one' || value === 'many';
}

function stableEntityId(name: string): string {
	const normalized = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');

	return normalized === '' ? 'entity' : normalized;
}

function stableAttributeId(entityId: string, attributeName: string): string {
	const normalized = attributeName
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	const suffix = normalized === '' ? 'attribute' : normalized;
	return `${entityId}:${suffix}`;
}

function validateDocumentShape(doc: unknown): string[] {
	const issues: string[] = [];

	if (!isObject(doc)) {
		issues.push('Document must be an object');
		return issues;
	}

	if (doc.version !== 1) {
		issues.push('Document version must be 1');
	}

	const schema = doc.schema;
	if (!isObject(schema)) {
		issues.push('schema must be an object');
		return issues;
	}

	if (typeof schema.name !== 'string' || schema.name.trim() === '') {
		issues.push('schema.name must be a non-empty string');
	}

	if (!Array.isArray(schema.entities)) {
		issues.push('schema.entities must be an array');
	} else {
		const entities = schema.entities as unknown[];
		const entityIds = new Set<string>();
		for (let i = 0; i < entities.length; i += 1) {
			const entity = entities[i];
			if (!isObject(entity)) {
				issues.push(`schema.entities[${i}] must be an object`);
				continue;
			}

			if (typeof entity.id !== 'string' || entity.id.trim() === '') {
				issues.push(`schema.entities[${i}].id must be a non-empty string`);
			} else if (entityIds.has(entity.id)) {
				issues.push(`schema.entities[${i}].id must be unique`);
			} else {
				entityIds.add(entity.id);
			}

			if (typeof entity.name !== 'string' || entity.name.trim() === '') {
				issues.push(`schema.entities[${i}].name must be a non-empty string`);
			}

			if (!isObject(entity.position) || typeof entity.position.x !== 'number' || typeof entity.position.y !== 'number') {
				issues.push(`schema.entities[${i}].position must contain numeric x and y`);
			}

			if (!Array.isArray(entity.attributes)) {
				issues.push(`schema.entities[${i}].attributes must be an array`);
				continue;
			}

			const attributes = entity.attributes as unknown[];
			const attributeIds = new Set<string>();
			for (let j = 0; j < attributes.length; j += 1) {
				const attribute = attributes[j];
				if (!isObject(attribute)) {
					issues.push(`schema.entities[${i}].attributes[${j}] must be an object`);
					continue;
				}

				if (typeof attribute.id !== 'string' || attribute.id.trim() === '') {
					issues.push(`schema.entities[${i}].attributes[${j}].id must be a non-empty string`);
				} else if (attributeIds.has(attribute.id)) {
					issues.push(`schema.entities[${i}].attributes[${j}].id must be unique within entity`);
				} else {
					attributeIds.add(attribute.id);
				}

				if (typeof attribute.name !== 'string' || attribute.name.trim() === '') {
					issues.push(`schema.entities[${i}].attributes[${j}].name must be a non-empty string`);
				}

				if (!isValueType(attribute.valueType)) {
					issues.push(`schema.entities[${i}].attributes[${j}].valueType must be a valid value type`);
				}

				if (!isCardinality(attribute.cardinality)) {
					issues.push(`schema.entities[${i}].attributes[${j}].cardinality must be one or many`);
				}
			}
		}
	}

	if (!Array.isArray(schema.relationships)) {
		issues.push('schema.relationships must be an array');
	}

	if (!Array.isArray(doc.entitiesData)) {
		issues.push('entitiesData must be an array');
	}

	if (!isObject(doc.view) || !isObject(doc.view.pan) || typeof doc.view.pan.x !== 'number' || typeof doc.view.pan.y !== 'number') {
		issues.push('view.pan must contain numeric x and y');
	}

	if (!isObject(doc.view) || typeof doc.view.zoom !== 'number' || doc.view.zoom <= 0) {
		issues.push('view.zoom must be a positive number');
	}

	return issues;
}

export function createEmptySchemaDesignerDocument(name = 'Untitled Schema'): SchemaDesignerDocument {
	return {
		version: 1,
		schema: {
			name,
			entities: [],
			relationships: []
		},
		entitiesData: [],
		view: {
			pan: { x: 0, y: 0 },
			zoom: 1
		}
	};
}

export function importSchemaDesignerDocument(input: unknown): SchemaDesignerDocument {
	const parsed: unknown = typeof input === 'string' ? (JSON.parse(input) as unknown) : input;
	const issues = validateDocumentShape(parsed);
	if (issues.length > 0) {
		throw new SchemaDesignerValidationError(issues);
	}

	return parsed as SchemaDesignerDocument;
}

export function exportSchemaDesignerDocument(document: SchemaDesignerDocument): string {
	const issues = validateDocumentShape(document);
	if (issues.length > 0) {
		throw new SchemaDesignerValidationError(issues);
	}

	return JSON.stringify(document, null, 2);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ownerEntityName(row: Record<string, unknown>): string {
	const keys = Object.keys(row).filter((key) => key.includes('/'));
	return keys[0]?.split('/')[0] ?? 'entity';
}

function lookupRefTargetId(
	pair: readonly [string, unknown],
	rows: Array<Record<string, unknown> & { id: number }>
): EntityId | null {
	const [attribute, scalar] = pair;
	const row = rows.find((candidate) => candidate[attribute] === scalar);
	return row ? row.id : null;
}

/**
 * Extracts the entity id a stored ref value points at, or null when the value
 * is not a resolvable reference. Handles branded engine refs (`ref(id)` and
 * `ref(lookupRef(...))`), wire-form `$ref` objects, and cardinality-many
 * arrays of refs.
 */
function refTargetId(value: unknown, rows: Array<Record<string, unknown> & { id: number }>): EntityId | null {
	if (Array.isArray(value)) {
		for (const item of value) {
			const resolved = refTargetId(item, rows);
			if (resolved !== null) {
				return resolved;
			}
		}
		return null;
	}

	if (isRef(value)) {
		const target = value[REF_BRAND];
		if (isTemp(target)) {
			return null;
		}
		if (isLookupRef(target)) {
			return lookupRefTargetId(target[LOOKUP_REF_BRAND], rows);
		}
		return target;
	}

	if (isPlainRecord(value) && '$ref' in value) {
		const target = value['$ref'];
		if (isPlainRecord(target) && '$lookupRef' in target) {
			const pair = target['$lookupRef'];
			if (Array.isArray(pair) && pair.length === 2) {
				return lookupRefTargetId(pair as unknown as readonly [string, unknown], rows);
			}
			return null;
		}
		return typeof target === 'number' || typeof target === 'string' ? target : null;
	}

	return null;
}

/**
 * Fallback for ref schemas without (resolvable) data: derives a candidate
 * target entity name from the ref attribute name (`authorId` -> `author`,
 * `blogPostId` -> `blog post`) and matches it against the declared entities
 * by stable id.
 */
function matchEntityNameFromRefName(refName: string, entityNames: string[]): string | null {
	const candidate = refName
		.replace(/Id$/, '')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.toLowerCase();
	const candidateId = stableEntityId(candidate);
	return entityNames.find((name) => stableEntityId(name) === candidateId) ?? null;
}

/**
 * Resolves the target entity of a ref attribute: first from stored ref values
 * in the entity data (the target row's owner entity), falling back to the
 * ref-name heuristic when there is no (resolvable) data.
 *
 * The stored value on a ref attribute may already be a plain entity id (or an
 * array of them for cardinality-many) instead of a branded `ref()` — those
 * are resolved here too, scoped to ref-typed attributes only.
 */
function resolveRelationshipTargetEntityName(
	ident: string,
	refName: string,
	rows: Array<Record<string, unknown> & { id: number }>,
	entityNames: string[]
): string | null {
	for (const row of rows) {
		const targetId = refTargetId(row[ident], rows) ?? plainRefTargetId(row[ident], rows);
		if (targetId === null) {
			continue;
		}

		const targetRow = rows.find((candidate) => candidate.id === targetId);
		if (!targetRow) {
			continue;
		}

		const ownerName = ownerEntityName(targetRow);
		if (entityNames.includes(ownerName)) {
			return ownerName;
		}
	}

	return matchEntityNameFromRefName(refName, entityNames);
}

/**
 * The default core read shape for a `ref()` value: a plain entity id, or an
 * array of plain ids for cardinality-many ref attributes. Only values that
 * name an actual row are treated as references.
 */
function plainRefTargetId(value: unknown, rows: Array<Record<string, unknown> & { id: number }>): EntityId | null {
	const candidates = Array.isArray(value) ? value : [value];
	for (const item of candidates) {
		if ((typeof item === 'number' || typeof item === 'string') && rows.some((row) => row.id === item)) {
			return item;
		}
	}
	return null;
}

/**
 * Reconstructs designer relationships from Fatos ref schema declarations
 * (`valueType: 'ref'` or `db/ref` true). The ref attribute's cardinality is
 * the relationship's `toCardinality` (that is how `toFatosTransactionEntries`
 * encodes it); `fromCardinality` is not stored in the snapshot and defaults
 * to 'one'. Relationship names are synthesized because the snapshot does not
 * carry user-authored names.
 */
function reconstructRelationships(
	schemas: SchemaInfo[],
	entities: Array<Record<string, unknown> & { id: number }>,
	entityList: SchemaDesignerEntity[],
	entityIdByName: Map<string, string>
): SchemaDesignerRelationship[] {
	const entityNames = entityList.map((entity) => entity.name);
	const relationships: SchemaDesignerRelationship[] = [];
	const usedRelationshipIds = new Set<string>();

	for (const schema of schemas) {
		if (schema.valueType !== 'ref' && schema.ref !== true) {
			continue;
		}

		const [entityName, ...attributeSegments] = schema.ident.split('/');
		if (!entityName || attributeSegments.length === 0) {
			continue;
		}

		const refName = attributeSegments.join('/');
		const fromEntityId = stableEntityId(entityName);
		if (!entityIdByName.has(entityName)) {
			continue;
		}

		const targetEntityName = resolveRelationshipTargetEntityName(schema.ident, refName, entities, entityNames);
		if (!targetEntityName) {
			continue;
		}

		const toEntityId = entityIdByName.get(targetEntityName);
		if (!toEntityId || fromEntityId === toEntityId) {
			continue;
		}

		const alreadyReconstructed = relationships.some(
			(relationship) =>
				relationship.fromEntityId === fromEntityId && relationship.referenceAttributeName === refName
		);
		if (alreadyReconstructed) {
			continue;
		}

		const baseId = `${fromEntityId}-${toEntityId}`;
		let id = baseId;
		let ordinal = 2;
		while (usedRelationshipIds.has(id)) {
			id = `${baseId}-${ordinal}`;
			ordinal += 1;
		}
		usedRelationshipIds.add(id);

		relationships.push({
			id,
			name: `${entityName} -> ${targetEntityName}`,
			fromEntityId,
			toEntityId,
			fromCardinality: 'one',
			toCardinality: schema.cardinality === 'many' ? 'many' : 'one',
			referenceAttributeName: refName
		});
	}

	return relationships.sort(
		(left, right) =>
			left.fromEntityId.localeCompare(right.fromEntityId) ||
			(left.referenceAttributeName ?? '').localeCompare(right.referenceAttributeName ?? '')
	);
}

export function toSchemaDesignerDocumentFromFatosSnapshot(snapshot: FatosJsonSnapshot): SchemaDesignerDocument {
	const schemas = [...(snapshot.schemas ?? [])].sort((left, right) => left.ident.localeCompare(right.ident));
	const entities = snapshot.entities ?? [];
	const byEntityName = new Map<string, SchemaDesignerEntity>();

	for (const schema of schemas) {
		const [entityName, ...attributeSegments] = schema.ident.split('/');
		if (!entityName || attributeSegments.length === 0) {
			continue;
		}

		const attributeName = attributeSegments.join('/');
		const entityId = stableEntityId(entityName);
		const entity = byEntityName.get(entityName) ?? {
			id: entityId,
			name: entityName,
			position: { x: byEntityName.size * 320, y: 80 },
			attributes: []
		};

		entity.attributes.push({
			id: stableAttributeId(entityId, attributeName),
			name: attributeName,
			valueType: schema.valueType,
			cardinality: schema.cardinality
		});

		byEntityName.set(entityName, entity);
	}

	const entityList = [...byEntityName.values()].sort((left, right) => left.name.localeCompare(right.name));
	const entityIdByName = new Map(entityList.map((entity) => [entity.name, entity.id]));
	const relationships = reconstructRelationships(schemas, entities, entityList, entityIdByName);

	const entitiesData: SchemaDesignerEntityData[] = entities
		.map((entity) => {
			const keys = Object.keys(entity).filter((key) => key.includes('/'));
			if (keys.length === 0) {
				return null;
			}

			const ownerName = keys[0]?.split('/')[0] ?? 'entity';
			const entityId = entityIdByName.get(ownerName) ?? stableEntityId(ownerName);
			const attributes = Object.fromEntries(
				keys.map((key) => {
					const [, ...attributeSegments] = key.split('/');
					const shortName = attributeSegments.join('/');
					return [shortName, entity[key]];
				})
			);

			return {
				eid: entity.id,
				entityId,
				attributes
			};
		})
		.filter((value): value is SchemaDesignerEntityData => value !== null);

	return {
		version: 1,
		schema: {
			name: 'Imported Fatos Snapshot',
			entities: entityList,
			relationships
		},
		entitiesData,
		view: {
			pan: { x: 0, y: 0 },
			zoom: 1
		}
	};
}

function toAttributeIdent(entityName: string, attributeName: string): string {
	return `${entityName}/${attributeName}`;
}

function pushMutation(entries: TransactionEntry[], eid: number, ident: string, value: unknown, isRefAttribute: boolean): void {
	if (Array.isArray(value)) {
		for (const item of value) {
			entries.push(['add', eid, ident, isRefAttribute ? ref(item as EntityId) : item]);
		}
		return;
	}

	entries.push(['add', eid, ident, isRefAttribute ? ref(value as EntityId) : value]);
}

export function toFatosTransactionEntries(document: SchemaDesignerDocument): TransactionEntry[] {
	const issues = validateDocumentShape(document);
	if (issues.length > 0) {
		throw new SchemaDesignerValidationError(issues);
	}

	const entries: TransactionEntry[] = [];
	const entityById = new Map(document.schema.entities.map((entity) => [entity.id, entity]));
	const schemaIdents = new Set<string>();
	const refIdents = new Set<string>();

	for (const entity of document.schema.entities) {
		for (const attribute of entity.attributes) {
			const ident = toAttributeIdent(entity.name, attribute.name);
			if (schemaIdents.has(ident)) {
				continue;
			}

			schemaIdents.add(ident);
			entries.push({
				ident,
				valueType: attribute.valueType,
				cardinality: attribute.cardinality
			});
		}
	}

	for (const relationship of document.schema.relationships) {
		const sourceEntity = entityById.get(relationship.fromEntityId);
		const targetEntity = entityById.get(relationship.toEntityId);
		if (!sourceEntity || !targetEntity) {
			continue;
		}

		const referenceName = relationship.referenceAttributeName ?? defaultReferenceAttributeName(targetEntity.name);
		const ident = toAttributeIdent(sourceEntity.name, referenceName);
		refIdents.add(ident);
		if (!schemaIdents.has(ident)) {
			schemaIdents.add(ident);
			entries.push({
				ident,
				valueType: 'ref',
				cardinality: relationship.toCardinality === 'many' ? 'many' : 'one'
			});
		}
	}

	for (const row of document.entitiesData) {
		const entity = entityById.get(row.entityId);
		if (!entity) {
			continue;
		}

		for (const [attributeName, value] of Object.entries(row.attributes)) {
			const ident = toAttributeIdent(entity.name, attributeName);
			pushMutation(entries, row.eid, ident, value, refIdents.has(ident));
		}
	}

	return entries;
}

export {
	addAttribute,
	addEntity,
	addRelationship,
	defaultReferenceAttributeName,
	formatCardinalityHint,
	moveEntity,
	removeRelationship,
	renameEntity,
	updateAttribute,
	updateRelationship,
	updateRelationshipName,
	type AddAttributeOptions,
	type AddEntityOptions,
	type AddRelationshipOptions,
	type UpdateAttributeOptions,
	type UpdateRelationshipOptions
} from './editor';

