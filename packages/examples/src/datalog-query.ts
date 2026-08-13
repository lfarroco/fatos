/**
 * Datalog-style queries — joins, projections, and transaction-scoped reads.
 *
 * The query engine evaluates `QuerySpec` objects (find/where) against the
 * materialized fact store, including joins across clauses, constants in the
 * projection, duplicate elimination, cardinality-many values, and as-of reads.
 */
import { createDatabase } from '@fatos/core';
import type { QueryTerm } from '@fatos/core';
import { log, section } from './helpers';

export type QueryResult = {
	allUsers: QueryTerm[][];
	names: QueryTerm[][];
	withConstant: QueryTerm[][];
	deduplicated: QueryTerm[][];
	tagged: QueryTerm[][];
	currentUsers: QueryTerm[][];
	usersBeforeRetraction: QueryTerm[][];
};

export function run(): QueryResult {
	section('Datalog queries — join, project, and time-travel');

	const db = createDatabase();

	db.transact([{ ident: 'user/tags', valueType: 'string', cardinality: 'many' }]);
	db.transact([
		['add', 1, 'type', 'user'],
		['add', 1, 'name', 'Alice'],
		['add', 1, 'user/tags', 'ts'],
		['add', 2, 'type', 'user'],
		['add', 2, 'name', 'Bob'],
		['add', 2, 'user/tags', 'ts'],
		['add', 3, 'type', 'admin'],
		['add', 3, 'name', 'Root'],
		['add', 4, 'type', 'user'],
		['add', 4, 'name', 'Alice']
	]);

	const allUsers = db.query({ find: ['?e'], where: [['?e', 'type', 'user']] });
	log('query', `All users: ${JSON.stringify(allUsers)}`);

	const names = db.query({
		find: ['?name'],
		where: [
			['?e', 'type', 'user'],
			['?e', 'name', '?name']
		]
	});
	log('query', `User names (join + project): ${JSON.stringify(names)}`);

	const withConstant = db.query({
		find: ['?e', 'user'],
		where: [
			['?e', 'type', 'user'],
			['?e', 'name', '?name']
		]
	});
	log('query', `Constants in the projection: ${JSON.stringify(withConstant)}`);

	const deduplicated = db.query({
		find: ['?name'],
		where: [
			['?e', 'type', 'user'],
			['?e', 'name', '?name']
		]
	});
	log('query', `Duplicate rows are eliminated (two users are named Alice): ${JSON.stringify(deduplicated)}`);

	const tagged = db.query({ find: ['?e'], where: [['?e', 'user/tags', 'ts']] });
	log('query', `Entities tagged "ts" (cardinality-many match): ${JSON.stringify(tagged)}`);

	// Retract entity 2's type, then compare current vs. past answers.
	db.retract(2, 'type', 'user');

	const currentUsers = db.query({ find: ['?e'], where: [['?e', 'type', 'user']] });
	const usersBeforeRetraction = db.query({ find: ['?e'], where: [['?e', 'type', 'user']] }, 2);
	log('query', `Users now:                    ${JSON.stringify(currentUsers)}`);
	log('query', `Users as of transaction 2:    ${JSON.stringify(usersBeforeRetraction)}`);

	return { allUsers, names, withConstant, deduplicated, tagged, currentUsers, usersBeforeRetraction };
}
