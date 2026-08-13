/**
 * Schema designer — visual documents meet the fact store.
 *
 * Builds a designer document with the editor helpers, round-trips it through
 * import/export, converts it to Fatos transactions, and imports a live Fatos
 * snapshot back into a designer document.
 */
import { createDatabase } from '@fatos/core';
import type { FactDatabase } from '@fatos/core';
import {
	addAttribute,
	addEntity,
	addRelationship,
	createEmptySchemaDesignerDocument,
	exportSchemaDesignerDocument,
	importSchemaDesignerDocument,
	moveEntity,
	renameEntity,
	SchemaDesignerValidationError,
	toFatosTransactionEntries,
	toSchemaDesignerDocumentFromFatosSnapshot,
	type FatosJsonSnapshot,
	type SchemaDesignerDocument
} from '@fatos/schema-designer';
import { log, section } from './helpers';

type EntityState = ReturnType<FactDatabase['entity']>;

export type SchemaDesignerResult = {
	document: SchemaDesignerDocument;
	restored: SchemaDesignerDocument;
	entriesCount: number;
	userEntity: EntityState;
	postEntity: EntityState;
	importedEntities: number;
	validationError: string;
};

export function run(): SchemaDesignerResult {
	section('Schema designer — documents, validation, and Fatos adapters');

	let document = createEmptySchemaDesignerDocument('Blog');

	const { entityId: userId, document: withUser } = addEntity(document, {
		name: 'User',
		position: { x: 40, y: 80 }
	});
	document = withUser;
	document = addAttribute(document, { entityId: userId, name: 'name', valueType: 'string', cardinality: 'one' });
	document = addAttribute(document, { entityId: userId, name: 'age', valueType: 'number', cardinality: 'one' });

	const { entityId: postId, document: withPost } = addEntity(document, {
		name: 'Post',
		position: { x: 360, y: 80 }
	});
	document = withPost;
	document = addAttribute(document, { entityId: postId, name: 'title', valueType: 'string', cardinality: 'one' });
	document = addAttribute(document, { entityId: postId, name: 'tags', valueType: 'string', cardinality: 'many' });
	document = addRelationship(document, {
		name: 'author',
		fromEntityId: postId,
		toEntityId: userId,
		fromCardinality: 'one',
		toCardinality: 'many',
		referenceAttributeName: 'authorId'
	});
	document = moveEntity(document, userId, { x: 80, y: 120 });
	document = renameEntity(document, userId, 'User');

	const json = exportSchemaDesignerDocument(document);
	const restored = importSchemaDesignerDocument(json);
	log('designer', `Document round-trips through JSON (${restored.schema.entities.length} entities, ${restored.schema.relationships.length} relationship)`);

	document = {
		...document,
		entitiesData: [
			{ eid: 1, entityId: userId, attributes: { name: 'Alice', age: 30 } },
			{
				eid: 2,
				entityId: postId,
				attributes: { title: 'Hello fatos', tags: ['temporal', 'typescript'], authorId: 1 }
			}
		]
	};

	const entries = toFatosTransactionEntries(document);
	log('adapter', `Converted to ${entries.length} Fatos transaction entries`);

	const db = createDatabase();
	db.transact(entries);
	const userEntity = db.entity(1);
	const postEntity = db.entity(2);
	log('adapter', `User: ${JSON.stringify(userEntity)}`);
	log('adapter', `Post: ${JSON.stringify(postEntity)}`);

	const snapshot: FatosJsonSnapshot = {
		schemas: db.getSchemas(),
		entities: db
			.find({})
			.filter((entity) => typeof entity.id === 'number' && entity.id > 0) as Array<
			Record<string, unknown> & { id: number }
		>
	};
	const imported = toSchemaDesignerDocumentFromFatosSnapshot(snapshot);
	log(
		'adapter',
		`Fatos snapshot imported back into a designer document (${imported.schema.entities.length} entities)`
	);

	let validationError = '';
	try {
		importSchemaDesignerDocument({ ...document, version: 2 });
	} catch (error) {
		if (error instanceof SchemaDesignerValidationError) {
			validationError = error.issues.join('; ');
		} else {
			validationError = error instanceof Error ? error.message : String(error);
		}
	}
	log('validation', `Invalid document rejected: ${validationError}`);

	return {
		document,
		restored,
		entriesCount: entries.length,
		userEntity,
		postEntity,
		importedEntities: imported.schema.entities.length,
		validationError
	};
}
