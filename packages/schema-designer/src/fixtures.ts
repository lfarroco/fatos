/**
 * Round-trip test fixtures: small schema-designer documents used by the
 * Phase 7 import/export tests (document → Fatos transactions → core db →
 * Fatos snapshot → document).
 */

import { createEmptySchemaDesignerDocument } from './index';
import type { SchemaDesignerDocument } from './index';

/**
 * A small blog schema with two entities, a one-to-many relationship
 * (`post.authorId → user`), and data covering the supported value types:
 * string, date, bigint, string-many, and a ref attribute.
 */
export function makeBlogDocument(): SchemaDesignerDocument {
	const document = createEmptySchemaDesignerDocument('Blog');

	document.schema.entities.push(
		{
			id: 'user',
			name: 'user',
			position: { x: 0, y: 0 },
			attributes: [
				{ id: 'user:name', name: 'name', valueType: 'string', cardinality: 'one' },
				{ id: 'user:born', name: 'born', valueType: 'date', cardinality: 'one' },
				{ id: 'user:balance', name: 'balance', valueType: 'bigint', cardinality: 'one' },
				{ id: 'user:tags', name: 'tags', valueType: 'string', cardinality: 'many' }
			]
		},
		{
			id: 'post',
			name: 'post',
			position: { x: 360, y: 0 },
			attributes: [{ id: 'post:title', name: 'title', valueType: 'string', cardinality: 'one' }]
		}
	);

	document.schema.relationships.push({
		id: 'post-author',
		name: 'written by',
		fromEntityId: 'post',
		toEntityId: 'user',
		fromCardinality: 'many',
		toCardinality: 'one',
		referenceAttributeName: 'authorId'
	});

	document.entitiesData.push(
		{
			eid: 10,
			entityId: 'user',
			attributes: {
				name: 'Alice',
				born: new Date('1990-01-02T03:04:05.000Z'),
				balance: 10n,
				tags: ['admin', 'early-adopter']
			}
		},
		{
			eid: 20,
			entityId: 'post',
			attributes: {
				title: 'Hello fatos',
				authorId: 10
			}
		}
	);

	return document;
}
