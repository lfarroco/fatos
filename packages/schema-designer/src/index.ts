/**
 * @fatos/schema-designer
 *
 * Shared model, validation, and adapter helpers for a visual schema designer.
 */

export const version = '0.0.1';

export type ValueType = 'string' | 'number' | 'boolean' | 'null' | 'unknown';
export type Cardinality = 'one' | 'many';

export type SchemaInfo = {
	eid: number;
	ident: string;
	valueType: ValueType;
	cardinality: Cardinality;
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
	return value === 'string' || value === 'number' || value === 'boolean' || value === 'null' || value === 'unknown';
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

export function toSchemaDesignerDocumentFromFatosSnapshot(snapshot: FatosJsonSnapshot): SchemaDesignerDocument {
	const schemas = snapshot.schemas ?? [];
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
			relationships: []
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

function pushMutation(entries: TransactionEntry[], eid: number, ident: string, value: unknown): void {
	if (Array.isArray(value)) {
		for (const item of value) {
			entries.push(['add', eid, ident, item]);
		}
		return;
	}

	entries.push(['add', eid, ident, value]);
}

export function toFatosTransactionEntries(document: SchemaDesignerDocument): TransactionEntry[] {
	const issues = validateDocumentShape(document);
	if (issues.length > 0) {
		throw new SchemaDesignerValidationError(issues);
	}

	const entries: TransactionEntry[] = [];
	const entityById = new Map(document.schema.entities.map((entity) => [entity.id, entity]));
	const schemaIdents = new Set<string>();

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

		const referenceName = relationship.referenceAttributeName ?? `${targetEntity.name}Id`;
		const ident = toAttributeIdent(sourceEntity.name, referenceName);
		if (!schemaIdents.has(ident)) {
			schemaIdents.add(ident);
			entries.push({
				ident,
				valueType: 'number',
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
			pushMutation(entries, row.eid, ident, value);
		}
	}

	return entries;
}

export {
	addAttribute,
	addEntity,
	addRelationship,
	moveEntity,
	renameEntity,
	updateAttribute,
	updateRelationshipName,
	type AddAttributeOptions,
	type AddEntityOptions,
	type AddRelationshipOptions,
	type UpdateAttributeOptions
} from './editor';

