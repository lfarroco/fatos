/**
 * Schema designer tests
 */

import { describe, expect, it } from 'vitest';
import { createDatabase, lookupRef, ref, serializeValue } from '@fatos/core';
import {
	addAttribute,
	addEntity,
	addRelationship,
	defaultReferenceAttributeName,
	formatCardinalityHint,
	removeRelationship,
	SchemaDesignerValidationError,
	createEmptySchemaDesignerDocument,
	exportSchemaDesignerDocument,
	importSchemaDesignerDocument,
	moveEntity,
	renameEntity,
	toFatosTransactionEntries,
	toSchemaDesignerDocumentFromFatosSnapshot,
	updateAttribute,
	updateRelationship,
	updateRelationshipName,
	version
} from './index';
import type { FatosJsonSnapshot } from './index';
import { makeBlogDocument } from './fixtures';

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
		expect(entries).toContainEqual({ ident: 'user/orgId', valueType: 'ref', cardinality: 'one' });
		expect(entries).toContainEqual(['add', 10, 'user/name', 'Alice']);
		expect(entries).toContainEqual(['add', 10, 'user/tags', 'admin']);
		expect(entries).toContainEqual(['add', 10, 'user/tags', 'early-adopter']);
		expect(entries).toContainEqual(['add', 10, 'user/orgId', ref(200)]);
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
		expect(document.schema.relationships).toEqual([]);
		expect(document.entitiesData).toHaveLength(2);
		expect(document.entitiesData[0]?.attributes).toBeDefined();
	});

	it('reconstructs relationships from ref schemas using data, lookupRefs, and ref-name heuristics', () => {
		const document = toSchemaDesignerDocumentFromFatosSnapshot({
			schemas: [
				{ eid: -1, ident: 'post/title', valueType: 'string', cardinality: 'one' },
				{ eid: -2, ident: 'post/authorId', valueType: 'ref', cardinality: 'one' },
				{ eid: -3, ident: 'user/name', valueType: 'string', cardinality: 'one' },
				{ eid: -4, ident: 'user/slug', valueType: 'string', cardinality: 'one', unique: 'identity' },
				{ eid: -5, ident: 'owner/name', valueType: 'string', cardinality: 'one' },
				{ eid: -6, ident: 'org/ownerId', valueType: 'unknown', cardinality: 'one', ref: true }
			],
			entities: [
				{ id: 10, 'user/name': 'Alice', 'user/slug': 'alice' },
				{ id: 20, 'post/title': 'Hello', 'post/authorId': ref(lookupRef(['user/slug', 'alice'])) },
				{ id: 30, 'owner/name': 'Acme' }
			]
		});

		const relationshipsByFrom = new Map(
			document.schema.relationships.map((relationship) => [relationship.fromEntityId, relationship])
		);
		expect(document.schema.relationships).toHaveLength(2);

		// The ref attribute still survives as an entity attribute.
		expect(document.schema.entities.find((entity) => entity.name === 'post')?.attributes).toContainEqual({
			id: 'post:authorid',
			name: 'authorId',
			valueType: 'ref',
			cardinality: 'one'
		});

		// Target resolved through the stored lookupRef -> unique user/slug row.
		expect(relationshipsByFrom.get('post')).toMatchObject({
			fromEntityId: 'post',
			toEntityId: 'user',
			fromCardinality: 'one',
			toCardinality: 'one',
			referenceAttributeName: 'authorId'
		});

		// No data for org/ownerId: the target is derived from the ref name, and
		// `db/ref` true (without valueType 'ref') still triggers reconstruction.
		expect(relationshipsByFrom.get('org')).toMatchObject({
			fromEntityId: 'org',
			toEntityId: 'owner',
			fromCardinality: 'one',
			toCardinality: 'one',
			referenceAttributeName: 'ownerId'
		});
	});

	it('round-trips a document through a core database snapshot (Phase 7 fixture)', () => {
		const document = makeBlogDocument();
		const entries = toFatosTransactionEntries(document);

		const db = createDatabase();
		db.transact(entries);

		const snapshot: FatosJsonSnapshot = {
			schemas: db.getSchemas(),
			entities: db
				.find({})
				.filter((entity) => typeof entity.id === 'number' && entity.id > 0) as Array<
				Record<string, unknown> & { id: number }
			>
		};

		const imported = toSchemaDesignerDocumentFromFatosSnapshot(snapshot);

		// Schema entities survive with their attributes.
		expect(imported.schema.entities.map((entity) => entity.name).sort()).toEqual(['post', 'user']);

		const user = imported.schema.entities.find((entity) => entity.name === 'user');
		expect(user?.attributes).toEqual(
			expect.arrayContaining([
				{ id: 'user:name', name: 'name', valueType: 'string', cardinality: 'one' },
				{ id: 'user:born', name: 'born', valueType: 'date', cardinality: 'one' },
				{ id: 'user:balance', name: 'balance', valueType: 'bigint', cardinality: 'one' },
				{ id: 'user:tags', name: 'tags', valueType: 'string', cardinality: 'many' },
				{ id: 'user:postids', name: 'postIds', valueType: 'ref', cardinality: 'many' }
			])
		);

		// The relationship survives as a ref attribute on the source entity.
		// (The imported id is the converter's stable lowercased id.)
		const post = imported.schema.entities.find((entity) => entity.name === 'post');
		expect(post?.attributes).toContainEqual({
			id: 'post:authorid',
			name: 'authorId',
			valueType: 'ref',
			cardinality: 'one'
		});

		// Ref schemas are also reconstructed as relationships. The snapshot
		// does not store user-authored relationship names or the source-side
		// multiplicity, so the name is synthesized (`<source> -> <target>`)
		// and fromCardinality defaults to 'one'; referenceAttributeName and
		// toCardinality (encoded in the ref attribute's cardinality) survive
		// exactly.
		const relationshipsByFrom = new Map(
			imported.schema.relationships.map((relationship) => [relationship.fromEntityId, relationship])
		);
		expect(imported.schema.relationships).toHaveLength(2);

		expect(relationshipsByFrom.get('post')).toMatchObject({
			id: 'post-user',
			name: 'post -> user',
			fromEntityId: 'post',
			toEntityId: 'user',
			fromCardinality: 'one',
			toCardinality: 'one',
			referenceAttributeName: 'authorId'
		});

		expect(relationshipsByFrom.get('user')).toMatchObject({
			id: 'user-post',
			fromEntityId: 'user',
			toEntityId: 'post',
			fromCardinality: 'one',
			toCardinality: 'many',
			referenceAttributeName: 'postIds'
		});

		// Data attributes survive for the supported value types.
		const alice = imported.entitiesData.find((row) => row.eid === 10);
		expect(alice).toBeDefined();
		expect(alice?.attributes['name']).toBe('Alice');
		expect(serializeValue(alice?.attributes['born'])).toEqual({
			$date: new Date('1990-01-02T03:04:05.000Z').getTime()
		});
		expect(serializeValue(alice?.attributes['balance'])).toEqual({ $bigint: '10' });
		expect(alice?.attributes['tags']).toEqual(['admin', 'early-adopter']);

		const alicePostIds = alice?.attributes['postIds'] as unknown[] | undefined;
		expect(alicePostIds).toHaveLength(1);
		// ref values read back as plain ids by default; the converter
		// passes entity attribute values through verbatim
		expect(alicePostIds?.[0]).toBe(20);

		const hello = imported.entitiesData.find((row) => row.eid === 20);
		expect(hello).toBeDefined();
		expect(hello?.attributes['title']).toBe('Hello fatos');
		expect(hello?.attributes['authorId']).toBe(10);
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

	it('updates an existing attribute name and metadata', () => {
		const created = addEntity(createEmptySchemaDesignerDocument('Designer'), { name: 'User' });
		const withAttribute = addAttribute(created.document, {
			entityId: created.entityId,
			name: 'email',
			valueType: 'string',
			cardinality: 'one'
		});

		const attributeId = withAttribute.schema.entities[0]?.attributes[0]?.id;
		expect(attributeId).toBeDefined();

		const updated = updateAttribute(withAttribute, {
			entityId: created.entityId,
			attributeId: attributeId as string,
			name: 'age',
			valueType: 'number',
			cardinality: 'many'
		});

		expect(updated.schema.entities[0]?.attributes[0]).toEqual(
			expect.objectContaining({
				name: 'age',
				valueType: 'number',
				cardinality: 'many'
			})
		);
	});

	it('updates existing relationship name', () => {
		const first = addEntity(createEmptySchemaDesignerDocument('Designer'), { name: 'User' });
		const second = addEntity(first.document, { name: 'Org' });
		const linked = addRelationship(second.document, {
			name: 'member_of',
			fromEntityId: first.entityId,
			toEntityId: second.entityId,
			fromCardinality: 'many',
			toCardinality: 'one'
		});

		const relationshipId = linked.schema.relationships[0]?.id;
		expect(relationshipId).toBeDefined();

		const updated = updateRelationshipName(linked, relationshipId as string, 'belongs_to_org');
		expect(updated.schema.relationships[0]?.name).toBe('belongs_to_org');
	});

	it('rejects self-referencing relationships', () => {
		const created = addEntity(createEmptySchemaDesignerDocument('Designer'), { name: 'User' });
		const linked = addRelationship(created.document, {
			name: 'self_loop',
			fromEntityId: created.entityId,
			toEntityId: created.entityId,
			fromCardinality: 'one',
			toCardinality: 'many'
		});

		expect(linked.schema.relationships).toHaveLength(0);
	});

	it('rejects duplicate relationship names', () => {
		const first = addEntity(createEmptySchemaDesignerDocument('Designer'), { name: 'User' });
		const second = addEntity(first.document, { name: 'Org' });
		const linked = addRelationship(second.document, {
			name: 'member_of',
			fromEntityId: first.entityId,
			toEntityId: second.entityId,
			fromCardinality: 'many',
			toCardinality: 'one'
		});
		const duplicated = addRelationship(linked, {
			name: '  member_of  ',
			fromEntityId: second.entityId,
			toEntityId: first.entityId,
			fromCardinality: 'one',
			toCardinality: 'many'
		});

		expect(duplicated.schema.relationships).toHaveLength(1);
	});

	it('partially updates a relationship and clears the reference attribute', () => {
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

		const relationshipId = linked.schema.relationships[0]?.id;
		expect(relationshipId).toBeDefined();

		const partial = updateRelationship(linked, relationshipId as string, { toCardinality: 'many' });
		expect(partial.schema.relationships[0]?.toCardinality).toBe('many');
		expect(partial.schema.relationships[0]?.name).toBe('member_of');
		expect(partial.schema.relationships[0]?.fromCardinality).toBe('many');
		expect(partial.schema.relationships[0]?.referenceAttributeName).toBe('orgId');

		const cleared = updateRelationship(partial, relationshipId as string, { referenceAttributeName: '   ' });
		expect(cleared.schema.relationships[0]?.referenceAttributeName).toBeUndefined();
	});

	it('updateRelationshipName trims names and ignores empty names', () => {
		const first = addEntity(createEmptySchemaDesignerDocument('Designer'), { name: 'User' });
		const second = addEntity(first.document, { name: 'Org' });
		const linked = addRelationship(second.document, {
			name: 'member_of',
			fromEntityId: first.entityId,
			toEntityId: second.entityId,
			fromCardinality: 'many',
			toCardinality: 'one'
		});

		const relationshipId = linked.schema.relationships[0]?.id;
		expect(relationshipId).toBeDefined();

		const trimmed = updateRelationshipName(linked, relationshipId as string, '  author_of  ');
		expect(trimmed.schema.relationships[0]?.name).toBe('author_of');

		const kept = updateRelationshipName(trimmed, relationshipId as string, '');
		expect(kept.schema.relationships[0]?.name).toBe('author_of');
	});

	it('ignores updates and removals for unknown relationship ids', () => {
		const first = addEntity(createEmptySchemaDesignerDocument('Designer'), { name: 'User' });
		const second = addEntity(first.document, { name: 'Org' });
		const linked = addRelationship(second.document, {
			name: 'member_of',
			fromEntityId: first.entityId,
			toEntityId: second.entityId,
			fromCardinality: 'many',
			toCardinality: 'one'
		});

		const updated = updateRelationship(linked, 'missing', { name: 'renamed' });
		expect(updated.schema.relationships).toEqual(linked.schema.relationships);

		const removed = removeRelationship(linked, 'missing');
		expect(removed.schema.relationships).toEqual(linked.schema.relationships);
	});

	it('builds camelCase default reference attribute names', () => {
		expect(defaultReferenceAttributeName('Org')).toBe('orgId');
		expect(defaultReferenceAttributeName('User')).toBe('userId');
		expect(defaultReferenceAttributeName('Blog Post')).toBe('blogPostId');
		expect(defaultReferenceAttributeName('order-item')).toBe('orderItemId');
		expect(defaultReferenceAttributeName('')).toBe('Id');
	});

	it('formats cardinality hints', () => {
		expect(formatCardinalityHint('one', 'one')).toBe('1 — 1');
		expect(formatCardinalityHint('one', 'many')).toBe('1 — n');
		expect(formatCardinalityHint('many', 'one')).toBe('n — 1');
		expect(formatCardinalityHint('many', 'many')).toBe('n — n');
	});

	it('derives the reference attribute ident from the target entity name when unspecified', () => {
		const document = createEmptySchemaDesignerDocument('CRM');
		document.schema.entities.push(
			{ id: 'user', name: 'User', position: { x: 0, y: 0 }, attributes: [] },
			{ id: 'org', name: 'Org', position: { x: 300, y: 0 }, attributes: [] }
		);
		document.schema.relationships.push({
			id: 'user-org',
			name: 'belongs_to',
			fromEntityId: 'user',
			toEntityId: 'org',
			fromCardinality: 'many',
			toCardinality: 'one'
		});

		const entries = toFatosTransactionEntries(document);
		expect(entries).toContainEqual({ ident: 'User/orgId', valueType: 'ref', cardinality: 'one' });
	});
});
