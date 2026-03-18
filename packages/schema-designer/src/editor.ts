import type {
	Cardinality,
	SchemaDesignerDocument,
	SchemaDesignerEntity,
	SchemaDesignerPoint,
	SchemaDesignerRelationship,
	ValueType
} from './index';

export type AddEntityOptions = {
	name?: string;
	position?: SchemaDesignerPoint;
};

export type AddRelationshipOptions = {
	name: string;
	fromEntityId: string;
	toEntityId: string;
	fromCardinality: Cardinality;
	toCardinality: Cardinality;
	referenceAttributeName?: string;
};

export type AddAttributeOptions = {
	entityId: string;
	name: string;
	valueType: ValueType;
	cardinality: Cardinality;
};

export type UpdateAttributeOptions = {
	entityId: string;
	attributeId: string;
	name?: string;
	valueType?: ValueType;
	cardinality?: Cardinality;
};

function slugify(value: string): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');

	return normalized === '' ? 'item' : normalized;
}

function nextEntityOrdinal(document: SchemaDesignerDocument): number {
	let max = 0;
	for (const entity of document.schema.entities) {
		const match = /^entity-(\d+)$/.exec(entity.id);
		if (match) {
			max = Math.max(max, Number(match[1]));
		}
	}

	return max + 1;
}

function nextRelationshipOrdinal(document: SchemaDesignerDocument): number {
	let max = 0;
	for (const relationship of document.schema.relationships) {
		const match = /^rel-(\d+)$/.exec(relationship.id);
		if (match) {
			max = Math.max(max, Number(match[1]));
		}
	}

	return max + 1;
}

function nextAttributeId(entity: SchemaDesignerEntity, name: string): string {
	const base = `${entity.id}:${slugify(name)}`;
	if (!entity.attributes.some((attribute) => attribute.id === base)) {
		return base;
	}

	let counter = 2;
	while (entity.attributes.some((attribute) => attribute.id === `${base}-${counter}`)) {
		counter += 1;
	}

	return `${base}-${counter}`;
}

function entityExists(document: SchemaDesignerDocument, entityId: string): boolean {
	return document.schema.entities.some((entity) => entity.id === entityId);
}

export function addEntity(
	document: SchemaDesignerDocument,
	options: AddEntityOptions = {}
): { document: SchemaDesignerDocument; entityId: string } {
	const ordinal = nextEntityOrdinal(document);
	const entityId = `entity-${ordinal}`;
	const name = options.name?.trim() || `Entity ${ordinal}`;
	const position = options.position ?? { x: 60 + (ordinal - 1) * 280, y: 80 };

	const entity: SchemaDesignerEntity = {
		id: entityId,
		name,
		position,
		attributes: []
	};

	return {
		entityId,
		document: {
			...document,
			schema: {
				...document.schema,
				entities: [...document.schema.entities, entity]
			}
		}
	};
}

export function moveEntity(
	document: SchemaDesignerDocument,
	entityId: string,
	position: SchemaDesignerPoint
): SchemaDesignerDocument {
	return {
		...document,
		schema: {
			...document.schema,
			entities: document.schema.entities.map((entity) => {
				if (entity.id !== entityId) {
					return entity;
				}

				return {
					...entity,
					position
				};
			})
		}
	};
}

export function renameEntity(
	document: SchemaDesignerDocument,
	entityId: string,
	name: string
): SchemaDesignerDocument {
	const nextName = name.trim();
	if (nextName === '') {
		return document;
	}

	return {
		...document,
		schema: {
			...document.schema,
			entities: document.schema.entities.map((entity) => {
				if (entity.id !== entityId) {
					return entity;
				}

				return {
					...entity,
					name: nextName
				};
			})
		}
	};
}

export function addAttribute(
	document: SchemaDesignerDocument,
	options: AddAttributeOptions
): SchemaDesignerDocument {
	return {
		...document,
		schema: {
			...document.schema,
			entities: document.schema.entities.map((entity) => {
				if (entity.id !== options.entityId) {
					return entity;
				}

				const attributeName = options.name.trim();
				if (attributeName === '') {
					return entity;
				}

				return {
					...entity,
					attributes: [
						...entity.attributes,
						{
							id: nextAttributeId(entity, attributeName),
							name: attributeName,
							valueType: options.valueType,
							cardinality: options.cardinality
						}
					]
				};
			})
		}
	};
}

export function updateAttribute(
	document: SchemaDesignerDocument,
	options: UpdateAttributeOptions
): SchemaDesignerDocument {
	return {
		...document,
		schema: {
			...document.schema,
			entities: document.schema.entities.map((entity) => {
				if (entity.id !== options.entityId) {
					return entity;
				}

				return {
					...entity,
					attributes: entity.attributes.map((attribute) => {
						if (attribute.id !== options.attributeId) {
							return attribute;
						}

						const nextName = options.name ?? attribute.name;
						return {
							...attribute,
							name: nextName,
							valueType: options.valueType ?? attribute.valueType,
							cardinality: options.cardinality ?? attribute.cardinality
						};
					})
				};
			})
		}
	};
}

export function addRelationship(
	document: SchemaDesignerDocument,
	options: AddRelationshipOptions
): SchemaDesignerDocument {
	if (!entityExists(document, options.fromEntityId) || !entityExists(document, options.toEntityId)) {
		return document;
	}

	if (options.fromEntityId === options.toEntityId) {
		return document;
	}

	const relationship: SchemaDesignerRelationship = {
		id: `rel-${nextRelationshipOrdinal(document)}`,
		name: options.name.trim() || `${options.fromEntityId} -> ${options.toEntityId}`,
		fromEntityId: options.fromEntityId,
		toEntityId: options.toEntityId,
		fromCardinality: options.fromCardinality,
		toCardinality: options.toCardinality,
		referenceAttributeName: options.referenceAttributeName?.trim() || undefined
	};

	return {
		...document,
		schema: {
			...document.schema,
			relationships: [...document.schema.relationships, relationship]
		}
	};
}

export function updateRelationshipName(
	document: SchemaDesignerDocument,
	relationshipId: string,
	name: string
): SchemaDesignerDocument {
	return {
		...document,
		schema: {
			...document.schema,
			relationships: document.schema.relationships.map((relationship) => {
				if (relationship.id !== relationshipId) {
					return relationship;
				}

				return {
					...relationship,
					name
				};
			})
		}
	};
}
