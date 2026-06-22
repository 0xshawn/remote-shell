import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: proxy the API and both WebSocket paths to the notebook server (default
// port 7682) so the app talks to one origin. Prod: `vite build` emits dist/,
// which the server serves directly.
const SERVER = process.env.NOTEBOOK_SERVER || 'http://localhost:7682';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': { target: SERVER, changeOrigin: true },
      '/healthz': { target: SERVER, changeOrigin: true },
      '/ws': { target: SERVER, ws: true, changeOrigin: true },
      '/nbws': { target: SERVER, ws: true, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
