# PromptMux

**One chat. Every model.** A full-stack AI chat platform that unifies multiple AI
providers (OpenAI, Anthropic, Google, Moonshot AI, DeepSeek, Mistral, Z.ai/GLM) behind a single,
polished interface — with mid-conversation model switching and Claude-Artifacts-style
live previews.

![stack](https://img.shields.io/badge/stack-React%2019%20%C2%B7%20Express%20%C2%B7%20MongoDB-6366f1)

## Features

- **Multi-provider, multi-model** — GPT, Claude, Gemini, Kimi, DeepSeek, Mistral and GLM models
  in one place, driven by a single editable registry (`server/src/config/registry.js`).
- **Switch models mid-conversation** — pick a different model for any message; every
  reply is badged with the model that wrote it. Full history is preserved per chat.
- **Live artifacts** — ask for a website, game, dashboard or component and the model's
  self-contained HTML/SVG output renders instantly in a sandboxed side panel
  (Preview / Code tabs, copy, open-in-new-tab).
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
  estimated cost in USD. Prices live in the model registry.
- **Persistent history** — conversations and messages stored in MongoDB, auto-titled,
  renameable, deletable.
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
│   ├── .env.example        # provider API keys + Mongo URI
│   └── src/
│       ├── index.js        # app entry (serves client/dist in production)
│       ├── config/         # db, model registry, system prompt
│       ├── models/         # Conversation, Message (Mongoose)
│       ├── providers/      # openai / anthropic / google / demo adapters
│       └── routes/         # /api/models, /api/conversations (+ SSE chat)
├── client/                 # React SPA
│   └── src/
│       ├── api/            # fetch helpers + SSE stream reader
│       ├── store/          # Zustand store (chat state machine)
│       ├── lib/            # artifact extraction / preview helpers
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

## Adding / renaming models

Edit `server/src/config/registry.js` and restart the server. Example — adding
"ChatGPT 5.5" when it ships:

```js
{ id: 'chatgpt-5.5', company: 'openai', name: 'ChatGPT 5.5', apiModel: 'gpt-5.5', tagline: 'Next-gen flagship' },
```

- `name` is what users see; `apiModel` is the exact id the provider API expects.
- To add a whole new company, add it to `COMPANIES` (with its env var name) and add a
  small adapter in `server/src/providers/` (see `openai.js` for the interface).

## Production (Ubuntu)

The Express server serves the built React app itself — one process, one port.

```bash
# on the server (or use the automated script)
sudo bash deploy/ubuntu-setup.sh      # installs Node 22, MongoDB 8, PM2, builds the app
nano server/.env                      # add real API keys
pm2 start deploy/ecosystem.config.cjs # run under PM2
pm2 save && pm2 startup               # survive reboots
```

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
| `OPENAI_API_KEY` | OpenAI models |
| `ANTHROPIC_API_KEY` | Claude models |
| `GOOGLE_API_KEY` | Gemini models |
| `MOONSHOT_API_KEY` / `MOONSHOT_BASE_URL` | Kimi/Moonshot (OpenAI-compatible) |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` | DeepSeek V4 Pro / Flash (OpenAI-compatible) |
| `MISTRAL_API_KEY` / `MISTRAL_BASE_URL` | Mistral Medium 3.5 / Small 4 / Large 3 / Codestral (OpenAI-compatible) |
| `ZAI_API_KEY` / `ZAI_BASE_URL` | GLM-5.2 / 5-Turbo / 4.x (OpenAI-compatible) |

Providers without keys simply show as locked in the model picker.

## Notes & limitations

- Artifact previews run in a sandboxed iframe (`sandbox="allow-scripts"`): the
  model's JS can run but cannot touch your app's origin/storage.
- No user accounts yet — it's a single-user workspace; the data layer is ready for
  an auth layer if you add one later.
- Moonshot's China endpoint: set `MOONSHOT_BASE_URL=https://api.moonshot.cn/v1`.
- Z.ai's China endpoint: set `ZAI_BASE_URL=https://open.bigmodel.cn/api/paas/v4`.
- DeepSeek V4 runs in "thinking mode" by default on their side — reasoning tokens are
  handled by DeepSeek; the chat output streams normally.
