# PromptMux

**One chat. Every model.** A full-stack AI chat platform that unifies multiple AI
providers (OpenAI, Anthropic, Google, Moonshot AI, DeepSeek, Mistral, Z.ai/GLM) behind a single,
polished interface — with mid-conversation model switching and Claude-Artifacts-style
live previews.

![stack](https://img.shields.io/badge/stack-React%2019%20%C2%B7%20Express%20%C2%B7%20MongoDB-6366f1)

## Features

- **Multi-provider, multi-model** — GPT, Claude, Gemini, Kimi, DeepSeek, Mistral and GLM models
  in one place, driven by a single model registry you edit in the browser (no code changes,
  no redeploy — see **Admin dashboard** below).
- **Admin dashboard** — a `/admin` area for the owner: add companies and models, set each
  model's input/output price, switch models on and off, paste API keys (encrypted in the
  database), pull the latest prices off a provider's pricing page for review, and see the
  last 30 days of spend per model.
- **Switch models mid-conversation** — pick a different model for any message; every
  reply is badged with the model that wrote it. Full history is preserved per chat.
- **Live artifacts** — ask for a website, game, dashboard or component and the model's
  self-contained HTML/SVG output renders instantly in a sandboxed side panel
  (Preview / Code tabs, copy, open-in-new-tab).
- **Point & edit** — no more "please change the button" and getting a whole new page back.
  Hit the crosshair button in the artifact panel, click the heading/button/section you
  want, and a little box opens next to it: say what to change and **only that element's
  markup is rewritten**. The rest of the document is spliced back byte-for-byte, so the
  model can't quietly redesign the parts you liked (and the request stays small and cheap
  — a one-line edit on a 3 KB page costs ~1k tokens). `↑` widens the selection to the
  parent element; every edit is saved as a "Targeted edit" turn in the chat, so it
  survives reload and older versions stay in the transcript.
- **Image upload + two-model vision routing** — attach images to any message. Models
  marked `vision` in the registry handle them natively; if your chat model can't see
  images (e.g. DeepSeek), a separate **image model** of your choice describes them and
  the text model answers from that description — so you can pair a cheap LLM with a
  free/cheap vision model. Both models' token usage and cost are tracked per message.
- **PDF upload** — attach PDFs to any message (paperclip or drag & drop). Text is
  extracted locally on the server (free) and injected as context, so **every** model —
  including text-only ones like DeepSeek — can answer questions about your documents.
  **Scanned/image-only PDFs** are auto-detected: pages are rendered to images and read
  by your chosen vision model, then the chat model answers from that reading. Extracted
  text/vision readings are stored on the message, so follow-ups work without re-uploading.
- **Token streaming** — real-time SSE streaming for every provider, with stop support.
- **Token & cost tracking** — every reply shows provider-reported input/output/total
  tokens (hover for the full rate breakdown), plus a per-chat running total with
  estimated cost in USD. Prices come from the model registry and are editable in the
  admin dashboard.
- **Persistent history** — conversations and messages stored in MongoDB, auto-titled,
  renameable, deletable.
- **A link per chat** — every chat gets its own URL (`/c/<id>`) the moment it starts, so
  you can bookmark it or send it to someone. **Share link** in the header copies it,
  sidebar chats are real links (⌘/ctrl-click for a new tab), and Back/Forward move
  between chats. Opening a deleted link drops you on a new chat with a notice.
- **Professional dark UI** — React 19 + Tailwind, markdown rendering with syntax
  highlighting, responsive down to mobile.
- **Offline demo provider** — try the whole experience (streaming + artifacts) with
  zero API keys.

## Tech stack

| Layer    | Tech |
| -------- | ---- |
| Frontend | React 19, Vite 8, Tailwind CSS 3, Zustand, react-markdown + highlight.js, lucide icons |
| Backend  | Node 22, Express, Mongoose, official SDKs (`openai`, `@anthropic-ai/sdk`, `@google/generative-ai`) |
| Database | MongoDB 8 |
| Realtime | Server-Sent Events (SSE) |

## Project structure

```
prompt-mux/
├── package.json            # root scripts (dev / build / start)
├── server/                 # Express API + LLM gateway
│   ├── .env.example        # config: Mongo, auth, SMTP, admin, provider API keys
│   ├── scripts/            # make-admin (grant/revoke admin from the CLI)
│   └── src/
│       ├── index.js        # app entry (serves client/dist in production)
│       ├── config/         # db, registry cache + seed defaults, system prompt, access rules
│       ├── models/         # Conversation, Message, User, Provider, LlmModel, ... (Mongoose)
│       ├── lib/            # secrets, PDF/image handling, SSRF-guarded fetch, price extraction
│       ├── providers/      # openai / anthropic / google / demo adapters
│       └── routes/         # /api/models, /api/conversations (+ SSE chat), /api/auth, /api/admin
├── client/                 # React SPA
│   └── src/
│       ├── api/            # fetch helpers + SSE stream reader
│       ├── store/          # Zustand store (chat state machine)
│       ├── lib/            # artifact extraction / preview helpers
│       ├── admin/          # the /admin dashboard (own store + panels)
│       └── components/     # Sidebar, MessageList, Composer, ModelPicker, ArtifactPanel, ...
└── deploy/                 # Ubuntu production: setup script, PM2, nginx
```

## Quickstart (development — macOS)

Prereqs: Node ≥ 20, MongoDB running locally (`brew services start mongodb-community`).

```bash
npm run install:all          # install root, server and client deps

cp server/.env.example server/.env
# edit server/.env — add keys for the providers you want (optional; demo works without)

npm run dev                  # starts API on :5050 + Vite dev server on :5173
```

Open **http://localhost:5173**.

> No keys yet? The **Demo Artist** model works offline and streams a sample
> interactive artifact so you can see everything working.

## Admin dashboard

The dashboard is **not** at `/admin` — that path gets scanned within minutes of a host
going public. It lives at a private URL instead, and there's an *Admin* link in the sidebar
once your account has the role. To find the address: it's printed in the server log at
startup, shown on the dashboard's **Settings** tab (copyable, and changeable), and returned
by `GET /api/auth/me` to admins only. Pin your own with `ADMIN_PATH` in `server/.env`:

```bash
ADMIN_PATH=my-secret-console        # -> https://your-host/my-secret-console
```

Leave it empty and the server generates one on first boot. Either way this is a second
line of defence, not the lock: every request still verifies you're a signed-in
administrator, and a wrong address returns a plain 404.

The registry lives in MongoDB, so everything here takes effect immediately — no editing
source files, no restart:

- **Companies** — add, rename or deactivate a provider. Most vendors ship an
  OpenAI-compatible API, so a brand-new company is usually just *adapter: openai* plus its
  base URL. **Paste the API key straight into the dashboard** — press *Key* on the company's
  row — and it is encrypted before it is stored. That is the normal path and it always wins
  over the environment. The `*_API_KEY` variables in `server/.env` are only a fallback, kept
  so installs that predate this dashboard keep working; a new company needs nothing there.
  "Test key" makes one real call to confirm it works, and "Discover models" asks the
  provider's own API which model ids it actually serves — the quickest way to spot a model
  that was renamed or retired.
- **Models** — add or edit a model (display name, the exact `apiModel` id the API expects,
  tagline, context window, vision support) and set its **input / output price in USD per 1M
  tokens**, which is what every cost figure in the app is computed from. Activate or
  deactivate models to control what appears in the model picker; existing chats that used a
  deactivated model still open and say so.
- **Pricing** — fetch prices from a provider's pricing page and review them (below).
- **Settings** — which model to use for reading pricing pages, how much of a page to read,
  and whether fetched prices need approval.
- **Overview / Activity** — a health panel (missing keys, unpriced models, whether key
  encryption is configured), the last **30 days of usage and estimated spend per model**,
  and the admin audit trail.

### Becoming the first admin

Add your address to `ADMIN_EMAILS` in `server/.env`, restart, then sign in — the account is
promoted on login. Unlike `ALLOWED_EMAILS`, leaving it empty grants nobody:

```bash
ADMIN_EMAILS=me@example.com          # exact addresses, comma-separated
```

Or do it straight from the command line, for an account that already exists:

```bash
npm --prefix server run make-admin -- me@example.com            # grant
npm --prefix server run make-admin -- me@example.com --revoke   # revoke
npm --prefix server run make-admin -- --list                    # who has access
```

Also set `ENCRYPTION_KEY` (`openssl rand -hex 32`) if you plan to store API keys in the
dashboard — see the environment-variable table below.

### How price fetching works

Model prices change, and a stale price means every cost figure in the app is wrong. So the
dashboard can read them for you:

1. You pick a company (or a single model) and confirm its pricing-page URL.
2. The server fetches that page — only public http/https addresses, with a size and time
   limit, so the feature can't be pointed at something inside your network.
3. The HTML is reduced to plain text with pricing tables kept intact, and handed to the
   **admin model** you chose in Settings, with a prompt that only allows it to report
   numbers literally printed on the page.
4. The result is a **proposal**, not a change: every row shows the model it matched, the
   old and new price, and the exact text on the page it came from. You tick the rows you
   believe and apply them; the rest are discarded. Previous prices are kept in each
   model's history.

Nothing is ever written to a model's price without that explicit approval — a made-up
number would quietly mis-bill every user of the app. Model *discovery* is the free
counterpart and involves no AI at all: it just asks the provider which model ids exist.

**Which pricing pages this can read** (checked 2026-08-04). A server-side fetch only sees
the HTML the server sends, so a pricing table drawn by JavaScript in the browser is
invisible to it:

| Provider | Auto-fetch | Page used |
| --- | --- | --- |
| OpenAI | yes | `developers.openai.com/api/docs/pricing.md` |
| Anthropic | yes | `platform.claude.com/docs/en/about-claude/pricing.md` |
| Google | yes | `ai.google.dev/gemini-api/docs/pricing` |
| DeepSeek | yes | `api-docs.deepseek.com/quick_start/pricing` |
| Z.ai (GLM) | yes | `docs.z.ai/guides/overview/pricing` |
| Mistral | yes | `mistral.ai/pricing/api/` |
| Moonshot (Kimi) | yes, per model | `platform.kimi.ai/docs/pricing/chat-k3.md` and siblings |

Three things worth knowing if you point this at a different page. Several vendors publish a
markdown twin of every docs page (just append `.md`), which is cleaner and cheaper to read
than the rendered HTML — the seeded OpenAI, Anthropic and Kimi URLs use it. The marketing
pricing page is usually the wrong target: `openai.com/api/pricing` returns 403 to anything
that isn't a browser, while the docs page serves the same table happily. And Kimi prices
per model rather than on one page, so those URLs live on the models themselves — use the
**Prices** button on a model's row instead of the company's *Fetch prices*.

### What the dashboard itself costs

Reading a pricing page and testing a key are both real, billed model calls, so both are
logged. **Overview → Admin operations** shows the last 30 days: cost, call count, tokens in
and out, and the share of your total spend, broken down by operation and by the model that
was billed — failures included, since a rejected request can still be charged for its input
tokens. A key test is capped to a handful of tokens (a few hundred-thousandths of a cent);
a price fetch is larger because it sends a page of text, typically 1,500–6,000 tokens.

## Production (Ubuntu)

The Express server serves the built React app itself — one process, one port.

```bash
# on the server (or use the automated script)
sudo bash deploy/ubuntu-setup.sh      # installs Node 22, MongoDB 8, PM2, builds the app
nano server/.env                      # add real API keys, JWT_SECRET and SMTP settings
pm2 start deploy/ecosystem.config.cjs # run under PM2
pm2 save && pm2 startup               # survive reboots
```

> **Set `ALLOWED_EMAILS` to your own address before going live**, unless you really want a
> public sign-up form spending your API credits.
>
> **Set `JWT_SECRET` (≥16 chars) and working SMTP settings before going live** — accounts
> and the sign-up OTP email depend on them, and without a login nobody (including you) can
> see any conversation. Registration is open to anyone who can reach the app, and API costs
> land on *your* provider keys, so gate it if the app is public (see "Notes & limitations").
> After editing `.env`, restart with `pm2 restart prompt-mux --update-env` (a plain restart
> may not pick up new env vars).

Put nginx in front (config in `deploy/nginx.conf`) for TLS and port 80/443.
The nginx config already disables response buffering on `/api/` so SSE streaming works.

Manual steps, if you prefer:

```bash
npm run install:all
npm run build          # builds client -> client/dist
NODE_ENV=production node server/src/index.js   # serves app + API on :5050
```

## Environment variables

| Variable | Purpose |
| -------- | ------- |
| `PORT` | API/app port (default `5050`) |
| `MONGODB_URI` | Mongo connection string (default `mongodb://127.0.0.1:27017/promptmux`) |
| `JWT_SECRET` | **Required** for accounts — signs the login cookie (≥16 chars; the server throws without it) |
| `ALLOWED_EMAILS` | Who may register: exact addresses and/or `@domain` entries, comma-separated. Empty = open sign-up |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` / `SMTP_SECURE` | Sends the sign-up / password-reset OTP emails |
| `ANONYMOUS_MESSAGE_LIMIT` | Messages a not-logged-in visitor may send (default `3`) |
| `OTP_EXPIRY_MINUTES` | OTP lifetime (default `10`) |
| `BCRYPT_ROUNDS` | Password hashing cost |
| `ADMIN_EMAILS` | Exact addresses (comma-separated) promoted to admin on sign-in. Empty = nobody |
| `ADMIN_PATH` | Private URL segment the dashboard is served from (never `/admin`). Empty = generated on first boot and stored in MongoDB |
| `ENCRYPTION_KEY` | 32 bytes (`openssl rand -hex 32`) — encrypts API keys saved in the dashboard. Falls back to a key derived from `JWT_SECRET`, so rotating that secret makes stored keys unreadable |
| `ADMIN_LLM_MODEL` | Fallback model id used to read pricing pages when Settings doesn't name one |
| `ADMIN_FETCH_ALLOW_PRIVATE` | Local development only: `1` lets the price fetcher reach private/loopback addresses. Leave unset in production |
| `OPENAI_API_KEY` | OpenAI models |
| `ANTHROPIC_API_KEY` | Claude models |
| `GOOGLE_API_KEY` | Gemini models |
| `MOONSHOT_API_KEY` / `MOONSHOT_BASE_URL` | Kimi/Moonshot (OpenAI-compatible) |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` | DeepSeek V4 Pro / Flash (OpenAI-compatible) |
| `MISTRAL_API_KEY` / `MISTRAL_BASE_URL` | Mistral Medium 3.5 / Small 4 / Large 3 / Codestral (OpenAI-compatible) |
| `ZAI_API_KEY` / `ZAI_BASE_URL` | GLM-5.2 / 5-Turbo / 4.x (OpenAI-compatible) |

The provider key variables are **fallbacks**: a key entered in the admin dashboard is
stored (encrypted) in MongoDB and wins over the matching variable. Providers with neither
simply show as locked in the model picker.

## Notes & limitations

- Artifact previews run in a sandboxed iframe (`sandbox="allow-scripts"`) under a
  no-network CSP: the model's JS can run, but it cannot touch your app's origin/storage
  and **cannot make any network request** — no fetch/XHR/beacon, no remote images, fonts,
  scripts or nested frames, no form posts. This matters because artifact code is written
  by a model that just read your PDFs and web pages: without it, one poisoned document
  could have the "artifact" quietly POST your whole chat history somewhere.
  Consequence: artifacts can't load remote images or CDN assets (the system prompt
  already forbids those — they'd show as broken images). "Open in new tab" is sandboxed
  the same way.
  One residual: a preview can still navigate *itself* to an external URL (no CSP
  directive or sandbox flag covers self-navigation). That's visible — the preview pane
  replaces itself — and since it can no longer read the API, it can only carry data the
  model already put in that artifact.
- Point & edit replaces one element at a time, so it's the wrong tool for "restructure the
  whole page" — for that, just ask in the chat as usual. There's no undo button yet;
  every version stays in the transcript, so click an older artifact card to get it back.
- **Accounts**: email + password with an OTP verification email, JWT in an httpOnly cookie
  (`server/src/middleware/auth.js`). Conversations belong to a `userId`, or to a
  `sessionId` for visitors who haven't signed up. Every conversation route filters by
  owner, so an unauthenticated `GET /api/conversations` returns `[]`.
  Abuse limits, all of them friction rather than guarantees:
  - **Sign-up** is closed to everyone outside `ALLOWED_EMAILS` when that's set, and open
    when it isn't. Leaving it open on a reachable host means strangers chatting on your
    provider keys, and your SMTP mailing codes to any address they type.
  - **Wrong OTP codes** are capped at 5 per code (`lib/otp.js`), after which the code is
    destroyed and a new one must be requested — at most one per minute per address. That's
    what stops a 6-digit code (900,000 possibilities) from being guessed.
  - **Logins** are capped at 8 per account and 40 per IP per 15 minutes; failures are
    recorded as `login_failed` in the audit log, rate-limit hits as `rate_limited`, and bad
    codes as `otp_failed`, so guessing leaves a trail. A successful login or password reset
    clears the account's counter.
  - `ANONYMOUS_MESSAGE_LIMIT` (default 3) covers both chat messages and artifact edits, but
    it's counted per `sessionId` and that id comes from the browser — clearing site data
    yields a fresh allowance. Treat it as a nudge, not a spending limit; `ALLOWED_EMAILS`
    plus turning anonymous use off is the real control.
  - A `/c/<id>` link only opens for the account (or session) that owns that chat.
  - Express runs with `trust proxy: 'loopback'` so `req.ip` and the audit log show the real
    client address behind nginx instead of `127.0.0.1`.
- Terminate TLS in front of the app (see `deploy/nginx.conf` + certbot) — the login cookie
  is only marked `Secure` when `NODE_ENV=production`, and passwords are posted on login.
- Moonshot's China endpoint: set `MOONSHOT_BASE_URL=https://api.moonshot.cn/v1`.
- Z.ai's China endpoint: set `ZAI_BASE_URL=https://open.bigmodel.cn/api/paas/v4`.
- DeepSeek V4 runs in "thinking mode" by default on their side — reasoning tokens are
  handled by DeepSeek; the chat output streams normally.
