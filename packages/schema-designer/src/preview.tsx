import React from 'react';
import { createRoot } from 'react-dom/client';
import { SchemaDesignerWorkspace } from './react';

const container = document.getElementById('app');
if (!container) {
	throw new Error('Missing #app element');
}

const root = createRoot(container);
root.render(
	React.createElement(React.StrictMode, null, React.createElement(SchemaDesignerWorkspace, null))
);
