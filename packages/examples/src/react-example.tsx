/**
 * React — hooks for reactive UIs.
 *
 * A small todo app built with FatosProvider and the @fatos/react hooks.
 * `useQuery`, `useEntity`, and `useDatalogQuery` re-render whenever their
 * results change; `useTransaction` renders the append-only history.
 */
import { renderToString } from 'react-dom/server';
import type { ReactElement } from 'react';
import {
	createClient,
	FatosProvider,
	useDatalogQuery,
	useEntity,
	useFatosClient,
	useQuery,
	useTransaction
} from '@fatos/react';
import type { FatosClient } from '@fatos/react';
import { log, section } from './helpers';

function TodoRow({ eid }: { eid: number | string }) {
	const todo = useEntity(eid);
	if (!todo) {
		return null;
	}

	return <li data-eid={String(todo.id)}>{String(todo['todo/title'])}</li>;
}

function TodoList({ done }: { done: boolean }) {
	const todos = useQuery({ 'todo/done': done });
	return (
		<ul className={done ? 'completed-list' : 'pending'}>
			{todos.map((todo) => (
				<TodoRow key={String(todo.id)} eid={todo.id} />
			))}
		</ul>
	);
}

function CompletedCount() {
	const rows = useDatalogQuery({ find: ['?e'], where: [['?e', 'todo/done', true]] });
	return <p className="completed">{`${rows.length} completed`}</p>;
}

function Timeline() {
	const transactions = useTransaction();
	return (
		<ol className="timeline">
			{transactions.map((tx) => (
				<li key={tx[0]}>{`tx ${tx[0]}`}</li>
			))}
		</ol>
	);
}

function AddTodoButton() {
	const client = useFatosClient();
	const addTodo = () => {
		const nextEid = 1000 + client.getTransactions().length;
		client.transact([
			['add', nextEid, 'todo/title', 'A brand new todo'],
			['add', nextEid, 'todo/done', false]
		]);
	};

	return <button onClick={addTodo}>Add todo</button>;
}

export function TodoApp({ client }: { client: FatosClient }): ReactElement {
	return (
		<FatosProvider client={client}>
			<div className="todo-app">
				<h1>Fatos Todo Example</h1>
				<AddTodoButton />
				<h2>Pending</h2>
				<TodoList done={false} />
				<h2>Completed</h2>
				<TodoList done={true} />
				<CompletedCount />
				<Timeline />
			</div>
		</FatosProvider>
	);
}

export function seedClient(): FatosClient {
	const client = createClient();
	client.transact([
		{ ident: 'todo/title', valueType: 'string', cardinality: 'one' },
		{ ident: 'todo/done', valueType: 'boolean', cardinality: 'one' }
	]);
	client.transact([
		['add', 1, 'todo/title', 'Buy milk'],
		['add', 1, 'todo/done', false],
		['add', 2, 'todo/title', 'Learn fatos'],
		['add', 2, 'todo/done', true]
	]);
	return client;
}

export type ReactExampleResult = {
	html: string;
};

export function run(): ReactExampleResult {
	section('React — hooks for reactive UIs');
	const client = seedClient();
	const html = renderToString(<TodoApp client={client} />);
	log('react', `Rendered ${html.length} characters of markup, e.g.:\n\n${html.slice(0, 320)}…`);
	return { html };
}

