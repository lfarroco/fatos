import { createRoot } from 'react-dom/client';
import { App } from './app';

const rootEl = document.getElementById('root');
if (!rootEl) {
	throw new Error('missing #root element');
}

createRoot(rootEl).render(<App />);
