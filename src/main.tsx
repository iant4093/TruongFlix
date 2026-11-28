import React from 'react';
import ReactDOM from 'react-dom/client';
import CrashScreen from './components/common/CrashScreen';
import { finishRestore } from './services/backup';
import './index.css';

// In a plain browser during development, fake the Tauri backend so the UI can be previewed.
const boot =
  import.meta.env.DEV && !('__TAURI_INTERNALS__' in window)
    ? import('./dev/mockTauri').then((m) => m.installMocks())
    : Promise.resolve();

// A restored backup's preferences go into the window's storage before the app's modules read it
// (a failed restore is reported by the app).
boot
  .then(() => finishRestore().catch(() => null))
  .then(() => import('./App'))
  .then(({ default: App }) => {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <CrashScreen>
          <App />
        </CrashScreen>
      </React.StrictMode>,
    );
  });
