/**
 * Schema designer tests
 */

import { describe, expect, it } from 'vitest';
import {
	addAttribute,
	addEntity,
	addRelationship,
	SchemaDesignerValidationError,
	createEmptySchemaDesignerDocument,
	exportSchemaDesignerDocument,
	importSchemaDesignerDocument,
	moveEntity,
	renameEntity,
	toFatosTransactionEntries,
	toSchemaDesignerDocumentFromFatosSnapshot,
	version
} from './index';

describe('@fatos/schema-designer', () => {
	it('should export version', () => {
		expect(version).toBeDefined();
	});

	it('creates an empty schema designer document', () => {
		const document = createEmptySchemaDesignerDocument('CRM');

		expect(document.schema.name).toBe('CRM');
		expect(document.schema.entities).toEqual([]);
		expect(document.schema.relationships).toEqual([]);
		expect(document.view.zoom).toBe(1);
	});

	it('round-trips valid documents through import and export', () => {
		const document = createEmptySchemaDesignerDocument('Shop');
		document.schema.entities.push({
			id: 'user',
			name: 'user',
			position: { x: 64, y: 40 },
			attributes: [
				{ id: 'user:name', name: 'name', valueType: 'string', cardinality: 'one' }
			]
		});

		const json = exportSchemaDesignerDocument(document);
		const parsed = importSchemaDesignerDocument(json);

		expect(parsed).toEqual(document);
	});

	it('throws a validation error for invalid documents', () => {
		expect(() =>
			importSchemaDesignerDocument({
				version: 2,
				schema: {
					name: 'Invalid',
					entities: [],
					relationships: []
				},
				entitiesData: [],
				view: {
					pan: { x: 0, y: 0 },
					zoom: 1
				}
			})
		).toThrow(SchemaDesignerValidationError);
	});

	it('converts schema-designer documents to Fatos transaction entries', () => {
		const document = createEmptySchemaDesignerDocument('CRM');
		document.schema.entities.push(
			{
				id: 'user',
				name: 'user',
				position: { x: 0, y: 0 },
				attributes: [
					{ id: 'user:name', name: 'name', valueType: 'string', cardinality: 'one' },
					{ id: 'user:tags', name: 'tags', valueType: 'string', cardinality: 'many' }
				]
			},
			{
				id: 'org',
				name: 'org',
				position: { x: 300, y: 0 },
				attributes: [
					{ id: 'org:name', name: 'name', valueType: 'string', cardinality: 'one' }
				]
			}
		);
		document.schema.relationships.push({
			id: 'user-org',
			name: 'user belongs to org',
			fromEntityId: 'user',
			toEntityId: 'org',
			fromCardinality: 'many',
			toCardinality: 'one',
			referenceAttributeName: 'orgId'
		});
		document.entitiesData.push({
			eid: 10,
			entityId: 'user',
			attributes: {
				name: 'Alice',
				tags: ['admin', 'early-adopter'],
				orgId: 200
			}
		});

		const entries = toFatosTransactionEntries(document);

		expect(entries).toContainEqual({ ident: 'user/name', valueType: 'string', cardinality: 'one' });
		expect(entries).toContainEqual({ ident: 'user/tags', valueType: 'string', cardinality: 'many' });
		expect(entries).toContainEqual({ ident: 'org/name', valueType: 'string', cardinality: 'one' });
		expect(entries).toContainEqual({ ident: 'user/orgId', valueType: 'number', cardinality: 'one' });
		expect(entries).toContainEqual(['add', 10, 'user/name', 'Alice']);
		expect(entries).toContainEqual(['add', 10, 'user/tags', 'admin']);
		expect(entries).toContainEqual(['add', 10, 'user/tags', 'early-adopter']);
		expect(entries).toContainEqual(['add', 10, 'user/orgId', 200]);
	});

	it('imports schemas and entities from a Fatos snapshot shape', () => {
		const document = toSchemaDesignerDocumentFromFatosSnapshot({
			schemas: [
				{ eid: -1, ident: 'user/name', valueType: 'string', cardinality: 'one' },
				{ eid: -2, ident: 'user/tags', valueType: 'string', cardinality: 'many' },
				{ eid: -3, ident: 'org/name', valueType: 'string', cardinality: 'one' }
			],
			entities: [
				{ id: 1, 'user/name': 'Alice', 'user/tags': ['admin'] },
				{ id: 2, 'org/name': 'Acme' }
			]
		});

		expect(document.schema.entities.map((entity) => entity.name)).toEqual(['org', 'user']);
		expect(document.entitiesData).toHaveLength(2);
		expect(document.entitiesData[0]?.attributes).toBeDefined();
	});

	it('adds and edits entities through editor helpers', () => {
		const initial = createEmptySchemaDesignerDocument('Designer');
		const created = addEntity(initial, { name: 'Account' });

		expect(created.entityId).toBe('entity-1');
		expect(created.document.schema.entities[0]?.name).toBe('Account');

		const moved = moveEntity(created.document, created.entityId, { x: 420, y: 220 });
		expect(moved.schema.entities[0]?.position).toEqual({ x: 420, y: 220 });

		const renamed = renameEntity(moved, created.entityId, 'Customer');
		expect(renamed.schema.entities[0]?.name).toBe('Customer');

		const withAttribute = addAttribute(renamed, {
			entityId: created.entityId,
			name: 'email',
			valueType: 'string',
			cardinality: 'one'
		});
		expect(withAttribute.schema.entities[0]?.attributes).toHaveLength(1);
		expect(withAttribute.schema.entities[0]?.attributes[0]?.name).toBe('email');
	});

	it('creates relationships only for valid entity references', () => {
		const first = addEntity(createEmptySchemaDesignerDocument('Designer'), { name: 'User' });
		const second = addEntity(first.document, { name: 'Org' });

		const linked = addRelationship(second.document, {
			name: 'member_of',
			fromEntityId: first.entityId,
			toEntityId: second.entityId,
			fromCardinality: 'many',
			toCardinality: 'one',
			referenceAttributeName: 'orgId'
		});

		expect(linked.schema.relationships).toHaveLength(1);
		expect(linked.schema.relationships[0]?.name).toBe('member_of');

		const ignoredInvalid = addRelationship(linked, {
			name: 'broken',
			fromEntityId: first.entityId,
			toEntityId: 'missing',
			fromCardinality: 'one',
			toCardinality: 'many'
		});

		expect(ignoredInvalid.schema.relationships).toHaveLength(1);
	});
});
