/**
 * Schemas — declaring value types and cardinality.
 *
 * Covers: schema-as-facts, value type validation, cardinality "one" rules,
 * retract-then-re-add updates, and cardinality "many" collections.
 */
import { createDatabase } from '@fatos/core';
import type { FactDatabase, SchemaInfo } from '@fatos/core';
import { log, section } from './helpers';

type EntityState = ReturnType<FactDatabase['entity']>;

export type SchemaResult = {
	schemas: SchemaInfo[];
	alice: EntityState;
	tagged: EntityState;
	valueTypeError: string;
	cardinalityError: string;
	redeclaredError: string;
};

export function run(): SchemaResult {
	section('Schemas — value types and cardinality');

	const db = createDatabase();

	log('schema', 'Declare attributes with value types and cardinality');
	db.transact([
		{ ident: 'user/name', valueType: 'string', cardinality: 'one' },
		{ ident: 'user/age', valueType: 'number', cardinality: 'one' },
		{ ident: 'user/tags', valueType: 'string', cardinality: 'many' }
	]);
	const schemas = db.getSchemas();
	log('schema', schemas);

	log('write', 'Write valid data');
	db.transact([
		['add', 1, 'user/name', 'Alice'],
		['add', 1, 'user/age', 22],
		['add', 1, 'user/tags', 'typescript'],
		['add', 1, 'user/tags', 'datomic']
	]);

	let valueTypeError = '';
	try {
		db.add(1, 'user/age', 'twenty-two');
	} catch (error) {
		valueTypeError = (error as Error).message;
	}
	log('validation', `Wrong value type rejected: ${valueTypeError}`);

	let cardinalityError = '';
	try {
		db.add(1, 'user/name', 'Alicia');
	} catch (error) {
		cardinalityError = (error as Error).message;
	}
	log('validation', `Cardinality conflict rejected: ${cardinalityError}`);

	let redeclaredError = '';
	try {
		db.transact([{ ident: 'user/name', valueType: 'number', cardinality: 'one' }]);
	} catch (error) {
		redeclaredError = (error as Error).message;
	}
	log('validation', `Conflicting re-declaration rejected: ${redeclaredError}`);

	log('update', 'Retract the old value, then add the new one — the append-only update pattern');
	db.retract(1, 'user/name', 'Alice');
	db.add(1, 'user/name', 'Alicia');
	const alice = db.entity(1);
	log('read', `Entity 1 after the update: ${JSON.stringify(alice)}`);

	log('collection', 'cardinality "many" attributes collect values into a set');
	db.add(1, 'user/tags', 'eav');
	const tagged = db.entity(1);
	log('read', `Entity 1 with tags: ${JSON.stringify(tagged)}`);

	return { schemas, alice, tagged, valueTypeError, cardinalityError, redeclaredError };
}
