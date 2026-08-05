import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5050',
        changeOrigin: true,
      },
      // Published artifact pages are rendered by Express, not by this SPA —
      // without this, /a/<id> in dev would fall through to index.html. A regex
      // key, not the '/a' prefix: that would also swallow /api and /assets.
      '^/a/': {
        target: 'http://localhost:5050',
        changeOrigin: true,
      },
    },
  },
});
