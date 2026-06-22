import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@xterm/xterm/css/xterm.css';
import 'highlight.js/styles/github-dark.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
