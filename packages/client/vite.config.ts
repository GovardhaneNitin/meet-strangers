import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER_URL = process.env.MEET_STRANGERS_SERVER_URL ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Keep the browser same-origin in development, exactly like production
      // where the server serves both the page and the socket.
      '/ws': { target: SERVER_URL.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
