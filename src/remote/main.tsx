import React from 'react';
import ReactDOM from 'react-dom/client';
import RemoteApp from './RemoteApp';
import '../index.css';

// `npm run dev` → /remote.html?mock previews the browser app without the desktop app.
const ready = import.meta.env.DEV && new URLSearchParams(location.search).has('mock') ? import('./devMock').then((m) => m.installRemoteMock()) : Promise.resolve();

void ready.then(() =>
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <RemoteApp />
    </React.StrictMode>,
  ),
);
