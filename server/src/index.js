import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connectDB } from './config/db.js';
import modelsRouter from './routes/models.js';
import conversationsRouter from './routes/conversations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5050;

app.use(cors());
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
    app.listen(PORT, () => console.log(`[server] listening on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('[db] failed to connect:', err.message);
    process.exit(1);
  });
