import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import express from 'express';
import fs from 'node:fs';
import cookieParser from 'cookie-parser';
import { connectDB } from './config/db.js';
import { initRegistry } from './config/registry.js';
import { initAdminPath, adminPathSegment } from './config/adminPath.js';
import { authMiddleware } from './middleware/auth.js';
import { requireAdmin } from './middleware/requireAdmin.js';
import modelsRouter from './routes/models.js';
import authRouter from './routes/auth.js';
import conversationsRouter from './routes/conversations.js';
import adminRouter from './routes/admin.js';

const app = express();
const PORT = process.env.PORT || 5050;

// nginx sits in front and forwards X-Forwarded-For. Without this, req.ip is always
// 127.0.0.1, which makes per-IP rate limits global and every audit entry useless
// for tracing abuse. 'loopback' trusts only the local proxy, not arbitrary callers
// claiming a forwarded IP.
app.set('trust proxy', 'loopback');

// NO CORS by design. The client is always same-origin — Express serves the built
// app in production, and Vite proxies /api in dev — so an Access-Control-Allow-Origin
// header would only ever help someone else's page read this user's chats.
// Authentication is now per-user via JWT cookie + email/password login.

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.json({ limit: '30mb' })); // generous: base64 image uploads
app.use(cookieParser());
app.use(authMiddleware);

app.get('/api/health', (req, res) => res.json({ ok: true, name: 'prompt-mux' }));
app.use('/api/models', modelsRouter);
app.use('/api/auth', authRouter);
app.use('/api/conversations', conversationsRouter);

// The admin API lives under the same private segment as the dashboard, so a scan
// of a public host finds nothing to probe. Mounted with a param and checked at
// request time because the segment is only known after the DB is read; mounted
// last so it can't shadow /api/models, /api/auth or /api/conversations. A wrong
// segment falls through to the 404 below — indistinguishable from any other bad
// path. requireAdmin goes here rather than inside the router so a handler added
// without its own guard still can't be reached.
const adminStack = express.Router();
adminStack.use(requireAdmin, adminRouter);

app.use('/api/:adminSegment', (req, res, next) => {
  const expected = adminPathSegment();
  // Plain next() (not next('router')) so a non-matching segment continues down
  // the app stack to the JSON 404 below, rather than escaping to Express's
  // default HTML error page.
  if (!expected || req.params.adminSegment !== expected) return next();
  adminStack(req, res, next);
});

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
  // The registry (companies, models, prices, provider keys) lives in MongoDB and
  // is cached in-process, so it has to be loaded before the first request.
  .then(() => initRegistry())
  // The dashboard's private URL segment is stored in Mongo (or pinned by
  // ADMIN_PATH), so it has to be resolved before the first request is routed.
  .then(() => initAdminPath())
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[server] listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[db] failed to connect:', err.message);
    process.exit(1);
  });
