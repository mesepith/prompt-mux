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
- `npm --prefix client test` / `npm --prefix server test` — `node --test` unit tests for the
  pure logic that point-and-edit depends on (HTML source scanner, edit-reply sanitizer).
  There is no broader suite: verify everything else by running the server and curling
  endpoints (see "Verifying" below).

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
- **Artifact previews are untrusted code with no network.** Two rules, both load-bearing:
  the iframe stays `sandbox="allow-scripts"` (never add `allow-same-origin`), and every
  preview document carries `PREVIEW_CSP` (`default-src 'none'`, images/media/fonts limited
  to `data:`/`blob:`, `form-action 'none'`) as a `<meta>` **first inside the head** —
  `withCsp()` handles the placement, and `artifacts.test.js` asserts it for each document
  shape. Inline script/style must stay allowed (that's the artifact plus the picker
  runtime); do not add `connect-src`, a remote `img-src`, or anything else that re-opens
  the network. Artifact HTML is model output steered by whatever was in the conversation,
  so the preview must never be able to reach the API. `openArtifactInNewTab()` follows the
  same rule via a sandboxed iframe on a blank page — never a `blob:` URL, which would
  inherit this app's origin.
- **No CORS, and one shared password.** The client is always same-origin (Express serves
  it in prod, Vite proxies `/api` in dev), so `server/src/index.js` sends no
  `Access-Control-Allow-Origin` — adding bare `cors()` back would let any site the user
  visits read every conversation, since the API has no per-request identity. Auth is
  optional HTTP Basic gated on `APP_PASSWORD`, applied as the first middleware so it
  covers the API, the SPA and static files (`/api/health` stays open for monitoring).
  Keep the startup warning when it's unset.
- **Point & edit** (surgical artifact editing) — the one invariant: *the model rewrites a
  fragment, the server splices it; nobody regenerates the document*.
  - `client/src/lib/htmlNodes.js` scans artifact source into elements with exact
    `[start, end)` offsets and `annotateHtml()` stamps `data-pm-node="<id>"` (id = index in
    that scan) into a **preview-only** copy. Never annotate what you store or splice, and
    never let the two scans diverge — the id→range mapping is the whole mechanism.
    It's covered by `client/src/lib/htmlNodes.test.js` (`npm --prefix client test`); add a
    case there for any parsing change.
    The scanner must agree with the *browser's* parse, because that's what the user
    clicked — in particular the optional-end-tag rules (`<ul><li><p>a<li>` makes two
    sibling `li`s, a table section closes an open `<caption>`) and the rule that a quote
    only delimits an attribute value when it follows `=`. When changing it, re-run the
    ground-truth check: annotate a sample, load it in an iframe, and assert every
    `[data-pm-node]` element's tag and nearest annotated ancestor match the scan.
  - `client/src/lib/pickerScript.js` is injected into the preview and reports the clicked
    id over postMessage. The sandbox has an opaque origin, so both sides authenticate by
    window identity (`event.source === iframe.contentWindow` in the panel,
    `event.source === window.parent` in the frame) — `event.origin` is `"null"` and must
    not be trusted. Message shapes are documented at the top of both files; keep them in sync.
  - `POST /api/conversations/:id/artifact-edit` re-extracts the artifact server-side and
    **refuses the edit unless `code.slice(start, end) === snippet`** — that check is what
    stops a stale selection from clobbering unrelated markup. Keep the fence regex in
    `server/src/lib/artifacts.js` identical to the client's.
  - Model output goes through `cleanFragment()` (`server/src/config/editPrompt.js`), which
    unwraps fences/prose and **rejects a whole-document reply**. Covered by
    `server/src/config/editPrompt.test.js` (`npm --prefix server test`).
  - Each edit is persisted as a user+assistant pair carrying `artifactEdit` metadata, so
    reloads, history and the artifact panel all keep working with no special cases. Older
    edit copies are summarized out of provider history (`keepFullFrom` in the messages
    route) so a long editing session doesn't resend the same document every turn.
  - `providers/demo.js#editFragment` is the offline stand-in (deterministic outline +
    `data-demo-edit`), so the flow is testable with no API keys. It is not a model call.
- **State**: single Zustand store (`client/src/store/useStore.js`). No prop-drilling
  of chat state; components read/write the store.
- **Routing**: hand-rolled, no router library — `client/src/lib/router.js` owns the two
  URL shapes (`/` = new chat, `/c/<id>` = a conversation) and the History API calls.
  The store drives it: `selectConversation`/`newChat` push, first send of a new chat
  `replace`s `/` with its permanent link, and `handleRouteChange` (wired to `popstate`
  in `App.jsx`) mirrors Back/Forward. Pass `{ updateUrl: false }` when the URL is
  already the source of truth. A `/c/<id>` that 404s clears to `/` and sets
  `linkError`. Deep links rely on the SPA fallback in `server/src/index.js` — keep it.
- **Styling**: Tailwind only, dark theme via the `surface-*` palette defined in
  `client/tailwind.config.js` + custom classes in `client/src/index.css`. No CSS files
  per component.
- Server is ESM (`"type": "module"`); always include `.js` extensions in relative imports.
- Don't commit `.env` or `node_modules` (see `.gitignore`). Keys only in `server/.env`;
  client learns availability via `GET /api/models`.
- **Never overwrite `server/.env`** (no `cp .env.example .env` after first setup) — it
  contains the user's real API keys. To add new variables, append/surgically edit lines.
  After any `.env` change, restart the server process. `client/vite.config.js` reads
  (never writes) `server/.env` so the dev proxy can authenticate when `APP_PASSWORD` is
  set — without that, every dev `/api` call would 401, because the browser authenticates
  to Vite on :5173 while the proxy's own request to :5050 carries no credentials.

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
# with APP_PASSWORD set, every call except /api/health needs -u "$APP_USER:$APP_PASSWORD"
curl -s -X POST localhost:5050/api/conversations \
  -H 'Content-Type: application/json' -d '{"modelId":"demo-artist"}'
curl -N -X POST localhost:5050/api/conversations/<id>/messages \
  -H 'Content-Type: application/json' -d '{"content":"hi"}'   # expect SSE stream
npm --prefix client test && npm --prefix server test          # unit tests pass
cd client && npm run build                    # client compiles
```

Point & edit, end to end with no keys (`demo-artist` streams an artifact offline):

```bash
# 1. grab the assistant message id + its artifact code from the SSE 'done' frame above
# 2. find an element's offsets with the same scanner the UI uses
node --input-type=module -e "
  import { scanHtmlNodes } from './client/src/lib/htmlNodes.js';
  const code = process.env.CODE; const n = scanHtmlNodes(code).find(x => x.tag === 'h1');
  console.log(JSON.stringify({ start: n.start, end: n.end, snippet: code.slice(n.start, n.end) }));
"
# 3. POST the edit and diff the returned artifact against the old one — everything outside
#    [start,end) must be byte-identical
curl -s -X POST localhost:5050/api/conversations/<id>/artifact-edit \
  -H 'Content-Type: application/json' \
  -d '{"messageId":"<msg>","artifactIndex":0,"start":..,"end":..,"snippet":"..","instruction":"make it bigger"}'
```

The `demo-artist` model streams offline (no keys needed) — use it for end-to-end checks.

## Production

Target: Ubuntu + nginx + PM2. Assets/scripts in `deploy/` (keep them in sync with any
port/process changes). SSE requires `proxy_buffering off` on `/api/` (already in
`deploy/nginx.conf`).
