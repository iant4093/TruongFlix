import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// In a plain browser during development, fake the Tauri backend so the UI can be previewed.
const boot =
  import.meta.env.DEV && !('__TAURI_INTERNALS__' in window)
    ? import('./dev/mockTauri').then((m) => m.installMocks())
    : Promise.resolve();

boot.then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
