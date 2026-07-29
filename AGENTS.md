# AGENTS.md — PromptMux

Context for coding agents working in this repo.

## What this is

Multi-provider AI chat app (React + Express + MongoDB). Users chat with models from
OpenAI / Anthropic / Google / Moonshot / DeepSeek / Mistral / Z.ai (GLM), can switch models
mid-conversation, and get Claude-Artifacts-style live HTML/SVG previews in a side panel.

## Commands

- `npm run install:all` — install root + server + client deps
- `npm run dev` — dev mode (API :5050 with `--watch`, Vite dev :5173 proxying `/api`)
- `npm run build` — production client build to `client/dist`
- `npm start` — production mode: Express serves API + built client on :5050
- Syntax check server: `cd server && node --check src/<file>.js`
- No test suite yet — verify changes by running the server and curling endpoints
  (see "Verifying" below).

## Architecture rules (keep it this way)

- **Model registry is the single source of truth**: `server/src/config/registry.js`.
  Add/rename models and companies there only. Never hardcode model lists in the client.
- **Provider adapters** in `server/src/providers/` all implement:
  `streamChat({ apiKey, baseURL?, apiModel, messages, system, signal, onToken }) -> Promise<{ content, usage }>`.
  `messages` is always `[{ role: 'user'|'assistant', content }]`; each adapter converts
  to its SDK's format. `usage` = `{ inputTokens, outputTokens, totalTokens, reasoningTokens? }`
  (null when the provider reports none). Routing lives in `providers/index.js` — the
  routes never import SDKs directly.
- **Usage & cost**: usage is saved on assistant messages (`Message.usage`) and shown
  client-side via `MessageMeta` (per message: model identity + tokens + cost) and
  `SessionUsage` in `App.jsx` (per chat).
  Cost comes from each model's `price: { in, out }` (USD per 1M tokens) in the registry —
  keep prices in sync with provider pricing pages; omit `price` to show tokens only.
- **Chat transport is SSE** over `POST /api/conversations/:id/messages` with event
  types `start | token | done | error`. The client parses it in
  `client/src/api/client.js#streamMessage`. Keep event shapes in sync on both sides.
- **Images & two-model vision**: user messages may carry `attachments` (image data URLs,
  validated in `server/src/lib/images.js`). Registry models have `vision: true/false`.
  If the chat model has `vision: false`, the messages route runs
  `providers/index.js#describeImages` with `conversation.visionModelId` and injects the
  description into the last user turn; the vision model never writes the reply. Assistant
  messages then store both `usage` (reply model) and `visionUsage` (image model) —
  `MessageMeta` renders both sections. Provider adapters accept
  `messages[].images` (data URLs) and convert per-SDK format.
- **PDFs**: uploaded as data URLs alongside images; text is extracted server-side with
  `pdfjs-dist` (`server/src/lib/pdf.js`) and stored on the message as
  `attachments[].textContent` (never the binary). History building injects the text
  (`pdfInjection`) with per-message char caps (`PDF_CURRENT_MAX_CHARS` for the carrying
  message, `PDF_HISTORY_MAX_CHARS` for older ones) to control token cost. Works with
  every model — no provider-native PDF APIs.
  **Scanned/image-only PDFs** (no text layer): `lib/pdfImages.js` renders pages to PNGs
  (pdfjs-dist + `@napi-rs/canvas`) and the route auto-runs the vision flow
  (`conversation.visionModelId`, else first available vision model) — the description
  replaces `textContent` and the attachment is marked `scanned: true`. Use ONE pdf.js
  (pdfjs-dist) for everything: mixing in unpdf caused API/worker version conflicts.
- **Artifacts** = fenced ```` ```html ```` / ```` ```svg ```` blocks in assistant content.
  Server nudges models to produce them via `config/systemPrompt.js`; client extracts
  them in `client/src/lib/artifacts.js` and previews in a sandboxed iframe
  (`sandbox="allow-scripts"` — do not loosen this).
- **State**: single Zustand store (`client/src/store/useStore.js`). No prop-drilling
  of chat state; components read/write the store.
- **Styling**: Tailwind only, dark theme via the `surface-*` palette defined in
  `client/tailwind.config.js` + custom classes in `client/src/index.css`. No CSS files
  per component.
- Server is ESM (`"type": "module"`); always include `.js` extensions in relative imports.
- Don't commit `.env` or `node_modules` (see `.gitignore`). Keys only in `server/.env`;
  client learns availability via `GET /api/models`.
- **Never overwrite `server/.env`** (no `cp .env.example .env` after first setup) — it
  contains the user's real API keys. To add new variables, append/surgically edit lines.
  After any `.env` change, restart the server process.

## Conventions

- Node 22+, MongoDB 8. Express 5 is installed — note the SPA fallback in
  `server/src/index.js` uses a middleware, not `app.get('*', ...)` (v5 wildcard syntax
  differs; keep the middleware style).
- Auto-title conversations from the first user message (done server-side in the
  messages route).
- Assistant messages with `error` set are excluded from provider history; keep that
  filter when touching history building.

## Verifying changes

```bash
mongod --version                              # db running?
node server/src/index.js &                    # start API
curl localhost:5050/api/health
curl -s -X POST localhost:5050/api/conversations \
  -H 'Content-Type: application/json' -d '{"modelId":"demo-artist"}'
curl -N -X POST localhost:5050/api/conversations/<id>/messages \
  -H 'Content-Type: application/json' -d '{"content":"hi"}'   # expect SSE stream
cd client && npm run build                    # client compiles
```

The `demo-artist` model streams offline (no keys needed) — use it for end-to-end checks.

## Production

Target: Ubuntu + nginx + PM2. Assets/scripts in `deploy/` (keep them in sync with any
port/process changes). SSE requires `proxy_buffering off` on `/api/` (already in
`deploy/nginx.conf`).
