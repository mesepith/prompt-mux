import fs from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dev convenience: if the API is password-protected (APP_PASSWORD in server/.env),
 * the browser can't authenticate through this proxy — it talks to :5173, and the
 * proxy's own request to :5050 carries no credentials — so every /api call would
 * 401. Read the password (never write it) and let the proxy authenticate itself.
 */
function proxyAuthHeaders() {
  const env = { ...process.env };
  try {
    const text = fs.readFileSync(new URL('../server/.env', import.meta.url), 'utf8');
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (match && !env[match[1]]) env[match[1]] = match[2].trim();
    }
  } catch {
    /* no server/.env — nothing to authenticate with */
  }
  if (!env.APP_PASSWORD) return undefined;
  const credentials = Buffer.from(`${env.APP_USER || 'promptmux'}:${env.APP_PASSWORD}`).toString('base64');
  return { Authorization: `Basic ${credentials}` };
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5050',
        headers: proxyAuthHeaders(),
      },
    },
  },
});
