import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connectDB } from './config/db.js';
import modelsRouter from './routes/models.js';
import conversationsRouter from './routes/conversations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5050;

// NO CORS by design. The client is always same-origin — Express serves the built
// app in production, and Vite proxies /api in dev — so an Access-Control-Allow-Origin
// header would only ever help someone else's page read this user's chats.
// (There is no auth on the API, so `cors()` made every conversation readable by any
// website the user happened to have open.) Add a narrowly scoped cors() here only if
// you ever host the client on a different origin, never `cors()` with no options.

const AUTH_USER = process.env.APP_USER || 'promptmux';
const AUTH_PASSWORD = process.env.APP_PASSWORD || '';

const safeEqual = (a, b) => {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
};

/**
 * Optional shared-password gate (HTTP Basic). PromptMux has no user accounts —
 * the whole workspace is one person's chats, including text extracted from every
 * PDF they uploaded — so a single password is what stops a reachable host from
 * handing all of it to anyone who asks. Set APP_PASSWORD in server/.env to turn
 * it on. Unset leaves the server open, which is fine on a laptop and not on a
 * public box; the startup warning says so.
 *
 * Deliberately first in the chain: unauthenticated callers shouldn't reach the
 * 30 MB JSON parser, the API, or the built client.
 */
app.use((req, res, next) => {
  if (!AUTH_PASSWORD) return next();
  if (req.path === '/api/health') return next(); // for deploy/monitoring checks
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const split = decoded.indexOf(':');
    if (split !== -1) {
      const user = decoded.slice(0, split);
      const password = decoded.slice(split + 1);
      if (safeEqual(user, AUTH_USER) && safeEqual(password, AUTH_PASSWORD)) return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="PromptMux", charset="UTF-8"');
  res.status(401).json({ error: 'Authentication required' });
});

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.json({ limit: '30mb' })); // generous: base64 image uploads

app.get('/api/health', (req, res) => res.json({ ok: true, name: 'prompt-mux' }));
app.use('/api/models', modelsRouter);
app.use('/api/conversations', conversationsRouter);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Production: serve the built client (client/dist) as a single deployable app.
const clientDist = path.resolve(__dirname, '../../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[server] listening on http://localhost:${PORT}`);
      if (AUTH_PASSWORD) console.log(`[auth] password required (user "${AUTH_USER}")`);
      else
        console.warn(
          '[auth] APP_PASSWORD is not set — anyone who can reach this port can read every chat, ' +
            'including text from uploaded PDFs. Set APP_PASSWORD in server/.env before exposing it.'
        );
    });
  })
  .catch((err) => {
    console.error('[db] failed to connect:', err.message);
    process.exit(1);
  });
