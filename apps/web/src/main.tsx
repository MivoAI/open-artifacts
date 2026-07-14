import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import './styles.css';

const root = document.querySelector<HTMLDivElement>('#root');

if (!root) throw new Error('Open Artifacts could not find the root element.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
