import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const host = process.env.TAURI_DEV_HOST;
// Games are Windows-only; other builds leave the games code out entirely.
const platform = process.env.TAURI_ENV_PLATFORM ?? (process.platform === 'win32' ? 'windows' : process.platform);

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [react()],
  define: { __GAMES__: JSON.stringify(platform === 'windows') },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
    // Browser previews only: Apple's chart feeds don't allow pages from other sites to read them
    // (the app reads them from Rust), so the dev server fetches them for the preview's mock.
    proxy: {
      '/__apple-charts': { target: 'https://rss.marketingtools.apple.com', changeOrigin: true, rewrite: (path) => path.replace(/^\/__apple-charts/, '') },
      '/__apple-music': { target: 'https://music.apple.com', changeOrigin: true, followRedirects: true, rewrite: (path) => path.replace(/^\/__apple-music/, '') },
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari14',
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    rollupOptions: {
      // The desktop app, plus the browser app served to phones/tablets on the home network.
      input: { main: 'index.html', remote: 'remote.html' },
    },
  },
});
