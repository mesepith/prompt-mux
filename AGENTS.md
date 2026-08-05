# AGENTS.md — PromptMux

Context for coding agents working in this repo.

## What this is

Multi-provider AI chat app (React + Express + MongoDB). Users chat with models from
OpenAI / Anthropic / Google / Moonshot / DeepSeek / Mistral / Z.ai (GLM), can switch models
mid-conversation, and get Claude-Artifacts-style live HTML/SVG previews in a side panel.
Admins manage the companies, models, prices and API keys from a dashboard served at a
private URL (never `/admin` — see the routing rules below).

## Commands

- `npm run install:all` — install root + server + client deps
- `npm run dev` — dev mode (API :5050 with `--watch`, Vite dev :5173 proxying `/api`)
- `npm run build` — production client build to `client/dist`
- `npm start` — production mode: Express serves API + built client on :5050
- Syntax check server: `cd server && node --check src/<file>.js`
- `npm --prefix server run make-admin -- <email>` (`--revoke`, `--list`) — grant/revoke
  admin on an existing account without editing `.env` or MongoDB
- `npm --prefix client test` / `npm --prefix server test` — `node --test` unit tests for the
  pure logic that point-and-edit depends on (HTML source scanner, edit-reply sanitizer).
  There is no broader suite: verify everything else by running the server and curling
  endpoints (see "Verifying" below).

## Architecture rules (keep it this way)

- **The model registry lives in MongoDB, not in code.** Companies and models are rows in
  the `providers` and `llmmodels` collections and are edited from the admin dashboard —
  adding a model is no longer a code change.
  - `server/src/config/seedRegistry.js` holds the built-in defaults (`SEED_COMPANIES`,
    `SEED_MODELS`, `ADAPTERS`). `seedRegistry()` inserts only what is *missing* on boot and
    **never overwrites an existing row**, so an admin's edits survive every restart and
    redeploy. The same defaults are the fallback when the DB can't be read at boot: a
    broken query must degrade the app to "the defaults", not to "no models".
  - `server/src/config/registry.js` is the in-process cache and exposes *synchronous*
    accessors (`getModel`, `getCompany`, `listModels`, `modelsForCompany`,
    `modelUnavailableReason`, …), because the rest of the app asks "what is model X?" in
    the middle of a request or halfway through an SSE stream, where an `await` on Mongo
    has no business being.
  - Two rules are load-bearing. **Every admin mutation must call `reloadRegistry()`** —
    without it that process happily serves the pre-edit registry until someone restarts
    it, and under PM2 cluster mode only the worker that handled the write would be right.
    And **API keys are never part of a cached company object**: they live in a private
    `Map` inside registry.js, so `res.json(company)` cannot leak one no matter which route
    does it. Ask explicitly with `resolveApiKey(company)`.
  - Never hardcode model lists in the client; it learns everything from `GET /api/models`.
- **Provider routing is keyed on `company.adapter`, not on the company id**
  (`providers/index.js`). Almost every vendor ships an OpenAI-compatible endpoint, so a
  brand-new company can be added from the dashboard with adapter `openai` plus its
  `baseURL` and it works with no deploy. Switching on company ids instead would put every
  new vendor back into a code change, which is the thing the dashboard exists to avoid.
  Keys and base URLs must come from `resolveApiKey()` / `resolveBaseURL()` (DB value
  first, env var as the fallback) — reading `process.env.OPENAI_API_KEY` directly silently
  ignores the key an admin just typed in.
- **Provider keys are encrypted at rest** — AES-256-GCM in `server/src/lib/secrets.js`,
  stored on `Provider.apiKeyEncrypted` (`select: false`; only `apiKeyLast4` is ever shown
  back to an admin). Without that, a Mongo dump, a backup or a stray `db.providers.find()`
  hands over every paid credential the instance owns. The encryption key comes from
  `ENCRYPTION_KEY` (32 bytes) or, when that is unset, is derived from `JWT_SECRET` so
  existing installs keep working with no `.env` edit — the consequence being that
  **rotating `JWT_SECRET` orphans every stored provider key** (env-var keys keep working;
  stored ones must be re-entered). `decryptSecret()` returns `null` rather than throwing
  for exactly that case: an unreadable key degrades to "this company has no key" instead
  of taking down boot and every chat request with it.
- **Admin authorization.** `User.role` (`'user' | 'admin'`) is the permission.
  `ADMIN_EMAILS` in `server/.env` is the bootstrap — `applyBootstrapAdmin` promotes a
  listed address on login and on email verification, so a fresh install has an admin
  without a hand-edit of Mongo, and so `role` is already correct when the client decides
  whether to show the Admin link. Empty `ADMIN_EMAILS` grants nobody (unlike
  `ALLOWED_EMAILS`, where empty means "open"); `make-admin` covers everything else.
  - `requireAdmin` is mounted **once**, on the private admin segment in `index.js` — not per route.
    That way a handler added to `routes/admin.js` is protected even if its author forgot,
    which is the only arrangement that survives future edits. Don't add a second guard
    inside the router; it just doubles the lookup.
  - The role is read from MongoDB on **every** admin request, never from the JWT, so
    revoking admin takes effect immediately instead of whenever a 7-day cookie expires.
    One indexed lookup, on admin routes only — the chat path is untouched.
  - Any new `admin_*` audit event name must be added to the enum in `models/AuditLog.js`
    or the write is **silently dropped** (`audit()` is fire-and-forget, so a validation
    failure never surfaces).
- **Price fetching is a human-approved pipeline, never an automatic write.**
  pricing URL → `lib/fetchUrl.js` (SSRF-guarded fetch) → `lib/htmlText.js` (HTML to text)
  → the admin LLM with a strict extraction prompt → `lib/priceExtract.js` (sanitize +
  match to registry slugs) → a `PriceProposal` an admin reviews and applies.
  - The invariant: **a fetched price is never written to a model without an explicit
    apply.** That number becomes the cost shown under every message, so one hallucinated
    decimal point silently mis-bills every user and nobody notices until the invoice
    arrives. `LlmModel.priceHistory` (capped at `MAX_PRICE_HISTORY`) keeps the previous
    values so a bad apply can be traced and undone.
  - **One model, one row per apply.** Pricing pages list the same model twice — a standard
    rate and a cache-hit rate — and extractors faithfully return both. Applying two rows
    for one model means the second silently wins, which is how DeepSeek's $0.435 input
    price becomes its $0.0036 cache rate and every cost in the app understates by 100×.
    `applyProposalItems` therefore refuses a selection containing two rows for one model
    (409 `DUPLICATE_MODEL_ROWS`), auto-apply *skips* those models rather than guessing, and
    `ProposalDrawer` leaves them unchecked — counting rows regardless of `applied`, so a
    leftover row can't look like the only candidate after a partial apply. Keep all three:
    each covers a case the others don't.
  - Two things learned the hard way about the fetch itself. The request sends
    `Accept-Language: en-US,en;q=0.9`, because without it a CDN serves the caller's locale
    and Google's pricing page arrives in French, where `1,50 $` reads as 150 to anything
    expecting a decimal point. And the route checks `hasPricingSignal()` on the extracted
    text before calling the model: some pages genuinely draw their pricing in the browser
    and a server-side fetch sees only marketing copy, where the honest answer is "this page
    can't be read server-side" rather than a paid call that tempts a model into reporting a
    monthly subscription as a token price. Keep that check *loose* — see the MDX note
    below; an over-strict version hid OpenAI's perfectly good table and blamed JavaScript.
  - `lib/fetchUrl.js` is security-critical: the *server* fetches an admin-supplied URL, so
    it is a textbook SSRF sink — on this box that reach includes cloud metadata, MongoDB
    on localhost and the other sites sharing the machine. It allows http/https on ordinary
    web ports only, resolves the host and checks every A/AAAA record against the private
    ranges, **re-runs both checks on every redirect hop** (a perfectly public host is free
    to answer `302 Location: http://169.254.169.254/`), and caps bytes and time. Keep all
    of those; `fetchUrl.test.js` covers them.
  - `lib/htmlText.js` deliberately preserves table structure (pipe-separated cells, one
    row per line). Prices live in tables, and a row broken across lines is exactly how a
    model comes to read an input price as an output price.
  - `lib/priceExtract.js` owns the prompt (JSON only; only prices literally printed on the
    page; no unit conversion or currency conversion; the page text is data, not
    instructions) and a parser that would rather drop a row than accept a number it can't
    justify. It is side-effect free and unit-tested — keep it that way.
  - **Every paid admin call is on the ledger.** `models/AdminUsage.js` records one row
    per price fetch and per key test, with tokens and the cost priced from the registry
    *at call time* (a later price edit must not rewrite history). This exists because the
    30-day spend figure comes from `Message.usage`, which those calls never touch — so
    without the ledger they are real money with no line item anywhere. Record failures
    too: a rejected request can still be billed for its input tokens. If you add another
    admin action that calls a model, it must call `recordAdminUsage` or spend goes dark.
  - **A key test is a real billed call.** There is no vendor-neutral "is this key valid"
    endpoint, so it sends one tiny message capped by `KEY_TEST_MAX_TOKENS` (that's why
    `maxTokens` is threaded through every adapter). Roughly 25 tokens, but not free — say
    so in the UI rather than implying it is.
  - **`stripMdxArtifacts` is what makes the `.md` twins usable.** MDX pages embed React:
    Kimi's pricing table arrives as `<>{"$"}3.00</>` next to ~700 characters of component
    definition. Unwrapping fragments and string expressions is the difference between
    "this vendor cannot be fetched" and a clean extraction. Related: `hasPricingSignal`
    must stay loose about currency — requiring `$` immediately before a digit fails on
    exactly these pages.
  - **A cached-input price above the uncached one means the columns were swapped.** Cache
    reads are always the discounted rate, so `parsePriceReply` swaps them back and warns.
    Kimi's K3 page, headed `Input (Cache Hit) | Input (Cache Miss) | Output`, otherwise
    yields `in: $0.30` against a real input price of `$3.00` — a tenfold understatement
    that looks entirely plausible in a diff.
  - **A company's prices may span several pages, so a company-level fetch is planned before
    it is paid for.** `lib/pricePlan.js#buildFetchPlan` decides which pages one click reads: a
    company-level `pricingUrl` means ONE call covers every model (DeepSeek — two models, one
    page), and without one the models are grouped by their own `pricingUrl`, so Kimi's K2.7
    pair sharing `chat-k27-code.md` costs one call and not two (four models over three pages).
    `GET /prices/plan` is **free — it calls no model** — and exists so the dialog can state
    "3 pages, about $0.001–$0.004" *before* the click. That ordering is the point: the cost was
    asked for up front, so anything that makes computing the plan itself expensive defeats it
    (keep `pricePlan.js` pure). `POST /prices/fetch-batch` then runs the pages
    **sequentially**, one proposal per page — parallel requests make us a worse neighbour to
    the vendor and blur the per-page cost in the ledger. Both routes go through the one shared
    `runPriceFetch()` page→proposal cycle, so validation, billing and auto-apply cannot drift
    between them; anything added to one path belongs in there. The batch reserves its whole
    allowance up front (`hitLimit(key, limit, cost)` takes a cost for exactly this), because a
    batch that dies half-finished leaves some models priced and others not — worse than
    refusing. `MAX_BATCH_FETCH` caps pages per click, and `plan.dropped` / `plan.uncovered`
    must always be surfaced: silent truncation would read as "every model was priced".
  - **Model discovery** (`lib/modelDiscovery.js`) asks a provider's own `/models` endpoint
    which ids it actually serves. It is free, involves no LLM, and the provider is the last
    word, so it — not the price fetcher — is how renamed and retired `apiModel` ids get
    caught. No provider exposes prices there, which is why pricing is a separate paid tool.
- **Provider adapters** in `server/src/providers/` all implement:
  `streamChat({ apiKey, baseURL?, apiModel, messages, system, signal, onToken }) -> Promise<{ content, usage }>`.
  `messages` is always `[{ role: 'user'|'assistant', content }]`; each adapter converts
  to its SDK's format. `usage` = `{ inputTokens, outputTokens, totalTokens, reasoningTokens? }`
  (null when the provider reports none). Routing lives in `providers/index.js` — the
  routes never import SDKs directly.
- **Usage & cost**: usage is saved on assistant messages (`Message.usage`) and shown
  client-side via `MessageMeta` (per message: model identity + tokens + cost) and
  `SessionUsage` in `App.jsx` (per chat).
  Cost comes from each model's `price: { in, out }` (USD per 1M tokens) in the registry,
  maintained in the dashboard's Models tab (by hand or via a reviewed price proposal).
  A model with no price shows tokens only — `toPublicModel` omits `price` unless both rates
  exist, because a half-filled `{ in: null }` would render `NaN` costs.
- **Every message write records both its owner and its client IP.** Neither can be
  reconstructed afterwards, so getting them wrong at write time is unrecoverable.
  - **The owner comes from the conversation, the IP from the request.**
    `messageOwner(conversation, req)` in `routes/conversations.js` is the only thing that
    stamps a message. The conversation is the authority — it cannot exist without an owner —
    while a request may arrive with neither an `auth-token` cookie nor an `X-Session-Id`
    header, and the previous `ownerId(req) || {}` then wrote a message with **no owner at
    all**: real tokens, real money, and no usage report able to attribute them to anybody
    (production held exactly those rows). The IP is still read from the request, because it
    describes who sent *this* message rather than who owns the chat.
  - **Read IPs through `lib/clientIp.js#clientIp`, never `X-Forwarded-For` directly** — a
    client can send that header itself, and Express already picks the correct hop thanks to
    the `trust proxy` setting (see the auth bullet below). Normalization is the other half:
    Node reports an IPv4 client on a dual-stack socket as `::ffff:1.2.3.4`, so without
    collapsing that, one visitor is stored as two addresses and every per-IP grouping lies;
    `::1` becomes `127.0.0.1` for the same reason. Values are capped at 45 characters (the
    longest textual IPv6). It is pure and unit-tested (`clientIp.test.js`) — keep it that way.
  - **Where it lands.** `Message.ip` per message, because a chat can be continued from a
    different network and attribution follows the request that spent the tokens;
    `Conversation.ip` + `Conversation.lastIp` (started from vs last written to — a chat that
    moved between the two is the interesting case); `User.signupIp` / `User.lastIp` /
    `User.lastLoginAt` as the summary the admin lists show. `AuditLog` already recorded a
    per-event IP. All three levels of the Usage tab show them: the distinct addresses per
    person (newest first, capped at 10 with `ipCount` beside it — the signal is "this account
    came from several networks", not a full address history), the chat's start/last pair (the
    second only when it differs), and the exact address per message. The vision leg of a
    message has none of its own: it is a server-side call inside the same request.
  - An IP is **personal data**. It is stored so an admin can attribute usage and investigate
    abuse — the same reason `AuditLog` has kept one since the auth work — so it belongs in
    whatever retention policy covers that collection.
- **Per-user usage reporting** — `lib/usageReport.js` plus the three `/usage/*` admin routes
  are the dashboard's Usage tab: who spent what, on which chats, in which messages. The
  pricing layer is pure, and `priceOf(modelId) -> { in, out } | null` is *injected* rather
  than imported from the registry, so the arithmetic is testable without booting a registry
  or a database. Six things it gets right on purpose:
  - **One message can bill two models.** `Message.usage` is the reply model; `visionUsage`
    is the separate vision model from the two-model image flow. Different prices, so a
    message's cost is two independently-priced calls summed — which is why
    `messageBreakdown` returns a `chat` leg, a `vision` leg and a total instead of one
    number. Any cost calculation that reads only `usage` understates every image
    conversation: on the live database `mistral-medium-3.5` appeared *twice* in the legacy
    bucket's `byModel` (before that bucket was cleared — see below), $0.0315 as a chat model
    and $0.0613 as a vision model, and the larger figure is the one a `usage`-only sum drops.
  - **Reasoning tokens are already inside `outputTokens`** — every provider we talk to
    reports them that way. Carry them for information, never add them to the bill: doing so
    inflates the cost of exactly the reasoning models people reach for.
  - **`costUsd: null` means "unknown", `0` means "free"**, and collapsing the two is how an
    unpriced model quietly reads as free and a partial total reads as the answer.
    `costOfCall` returns null, and `rollUp` also reports `unpricedModels` and `fullyPriced`
    so the UI can label a total as a floor.
  - **`rollUp`'s `messages` counts only `kind: 'chat'` rows.** The vision leg of a message
    is not another message. Tokens and cost sum over both kinds; the count must not.
  - **Aggregate in Mongo, price in JS.** The routes `$group` tokens by owner / chat / model
    (two passes, because `usage` and `visionUsage` are different fields, each tagged with
    `kind`) and hand the groups to `rollUp`. Prices can't be joined in — they live in the
    in-process registry cache, so no `$lookup` can reach them — and pulling every message
    into Node to price it there stops scaling the moment the history is real.
  - **`ownerKey` is the identity**: `user:<id>`, `session:<id>` or `legacy`. Anonymous
    sessions are deliberately in the report; they spend the owner's money exactly like a
    signed-in account does. `legacy` is chats from before conversations recorded an owner —
    they carry neither field, so there is genuinely nobody to attribute them to. That bucket
    *was* most of the history (290 of 348 messages, ~96% of spend); those chats (28–30 July
    2026) have since been backed up to JSON and deleted from both databases — 55
    conversations / 290 messages locally, 7 conversations / 14 messages on production, plus 7
    dangling messages whose conversations were already gone — so in practice it is now empty.
    **Keep the code path regardless**: the shape can recur (it is what the `messageOwner` rule
    above prevents, and it happened once), and a report that quietly drops the rows it cannot
    name understates the bill. The report labels that bucket "Before user accounts existed"
    and attaches a `note` saying why, because a nameless row holding real money reads as a
    bug otherwise. Listing those chats needs a match on *absence* (`{ userId: { $exists:
    false }, sessionId: { $exists: false } }`); there is no value to filter on.

  The honest limitation: **this is a cost report, not an invoice.** Messages don't store the
  price they were billed at, so every figure uses *today's* registry rates and a price
  edited yesterday silently re-prices last month. Every response returns `pricedAt` so the
  UI can state that, and it must. Back-dating each message against `LlmModel.priceHistory`
  is a possible future change, not what this does.
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
- **Published artifacts** (`/a/<publicId>`) — the panel's ↗ button gives a saved artifact a
  real, sendable address instead of an `about:blank` tab.
  - `POST /api/artifacts` is idempotent per (conversation, message, artifactIndex), so the
    same artifact always resolves to the same link, and **the body only names which
    artifact** — the server snapshots the code out of the stored message with the same
    `extractArtifacts`. Never accept client-sent code here: this endpoint would otherwise
    host arbitrary HTML on the app's own origin, the one place artifact code must not run.
  - A link is `shared: false` when minted; `PATCH /api/artifacts/:publicId { shared }` is
    the only thing that opens it up. `GET /a/<id>` renders the identical "not available"
    page for a wrong id, a deleted one and a private one that isn't yours — don't make the
    three distinguishable, or the id space becomes worth scanning. `publicId` is 96 random
    bits (`lib/publicArtifact.js`) because while a link is private it *is* the access
    control.
  - The page (`lib/artifactPage.js`) is a bare wrapper: the artifact reaches it only as a
    quoted `srcdoc` on an `allow-scripts` frame, under the same `PREVIEW_CSP`. Both halves
    are asserted in `artifactPage.test.js`; it duplicates the client's `buildPreviewDoc`
    minus the picker, so keep the two in sync like the fence regex.
  - The route is mounted in `index.js` **before** `express.static` and the SPA fallback,
    and proxied in `client/vite.config.js` for dev — otherwise `/a/<id>` renders the chat
    app instead.
  - Owner checks for the *page* can only use what a navigation carries: the `auth-token`
    cookie, or the `pm-session` cookie that `POST /api/artifacts` writes for an anonymous
    owner (the API keeps using the `X-Session-Id` header). Artifact rows carry their own
    `userId`/`sessionId`, so `mergeAnonymousSession()` moves them at login and
    `DELETE /api/conversations/:id` retires them.
- **No CORS, and per-user authentication.** The client is always same-origin (Express serves
  it in prod, Vite proxies `/api` in dev), so `server/src/index.js` sends no
  `Access-Control-Allow-Origin` — adding bare `cors()` back would let any site the user
  visits read every conversation. Auth is now per-user via email/password + JWT cookie
  (`auth-token`). Signup and forgot-password use a 6-digit OTP sent over SMTP. Users can
  also chat anonymously up to `ANONYMOUS_MESSAGE_LIMIT` total messages per browser session
  (`pm_session_id` in localStorage); after the limit, the UI prompts for login and the
  server merges their anonymous chats into the new account.
- **Auth abuse limits — keep these when touching `routes/auth.js`.** They exist because the
  app is internet-reachable and runs on the owner's paid keys:
  - Every OTP check goes through `lib/otp.js#consumeOtp`, never a bare
    `Otp.findOne({ code })`. It `$inc`s attempts atomically (so parallel guesses can't all
    read 0) and destroys the code after `MAX_OTP_ATTEMPTS`. A 6-digit code is 900,000
    possibilities — unlimited guesses on `/reset-password` was full account takeover.
  - Issue a new code only after `clearOtps()`, so codes can't stack up (one per minute
    against a 10-minute expiry meant ~10 live codes, i.e. 10× easier to guess), and delete
    the code if the email fails to send — never leave a code the user never received.
  - `/register` must NOT modify an existing unverified account's password: it's
    unauthenticated, so that let anyone pre-set the password of a pending signup.
  - Login goes through `hitLimit` per account and per IP, and every failure is audited
    (`login_failed`, `otp_failed`, `rate_limited`, `registration_blocked` — add new event
    names to the `AuditLog` enum or the write is silently rejected).
  - Sign-up is gated by `config/access.js#isRegistrationAllowed` (`ALLOWED_EMAILS`).
  - `app.set('trust proxy', 'loopback')` in `index.js` is what makes `req.ip` real behind
    nginx; without it every per-IP limit is global, and every audit row — plus every IP stored
    on a user, conversation or message — says `127.0.0.1`.
  - Unknown-email answers are deliberately consistent across `/forgot-password`, `/resend`
    and `/reset-password` (404 + `noAccount: true`). Don't "fix" one of them back to a fake
    200: `/register` already reveals existence via 409, and the fake success is what sent
    users to a code screen for an email that was never sent.
- **Shared chats.** Conversations are private by default. The owner can toggle
  `shared: true` (`PATCH /api/conversations/:id`). When shared, `GET /api/conversations/:id`
  is readable by anyone, but all writes (messages, rename, delete, artifact-edit) remain
  owner-only. A public viewer who sends a message forks the chat first via
  `POST /api/conversations/:id/fork`; the original conversation ID is never reused for
  another user's messages. The client tracks `isOwner`/`shared` from the GET response to
  show/hide editor controls and to decide whether to fork before writing.
- **Chat-driven patch edits** — the second surgical path, and the one that covers a game.
  Point & edit only reaches clickable elements (`script`/`style` are NOT_PICKABLE), so every
  "fix the collision" used to regenerate the whole document: measured on a real 618-line
  artifact, ~5,200 output tokens per fix, plus one full copy per past version left in the
  provider history. Now:
  - When a chat has an artifact, `PATCH_RULES` (`config/patchPrompt.js`) is appended to
    `SYSTEM_PROMPT` and the live source is injected ONCE into the last user message
    (`buildArtifactContext`, same pattern as `pdfInjection`), with a numbered outline from
    `lib/artifactMap.js`. Every artifact fence in the history is summarized away, so the
    model sees exactly one version instead of one per edit round.
  - The model answers with `<<<<<<< SEARCH / ======= / >>>>>>> REPLACE` blocks;
    `lib/patch.js` locates and splices them. **Uniqueness is mandatory** — not found, or
    found twice, is a refusal, because editing the wrong copy silently breaks a working
    game. Matching falls back exact -> trailing-space -> indentation (re-indenting from the
    mapping OBSERVED in the matched lines, not a guessed indent width), and application is
    **all-or-nothing**: a half-applied edit is the one outcome with no recovery.
  - Fallback chain: patch -> one repair call (the model sees its own failed blocks) -> a
    full rewrite. The rewrite call must re-frame `buildArtifactContext({ rewrite: true })`;
    leaving "do not reproduce it" in place is how a failed edit stores edit blocks as prose
    with the artifact missing. `artifactEdit.fallback` records it so a turn that quietly
    cost a rewrite is visible in the UI.
  - The result is stored as an ordinary artifact message — prose plus a full ```html fence.
    That is deliberate: the panel, point-and-edit offsets, published `/a/<id>` snapshots and
    the version history in the transcript all keep working with no patch-specific cases.
  - No blocks in the reply (a question, or a full rewrite) means today's behaviour exactly,
    which is what keeps a model that ignores the format working.
  - The SSE stream stops forwarding tokens at `patchMarkerIndex` (holding `SNIFF_HOLDBACK`
    characters back so a split marker can't leak) — nobody should watch `<<<<<<< SEARCH`
    scroll past. `reset` tells the client to drop an abandoned attempt before a rewrite.
  - `sumUsage` adds up all the calls in a turn; a multi-call turn must not report only the
    last one's tokens, and `totalTokens` must be a `Math.max` against input+output — summing
    only the calls that reported it is a truthy undercount. `demo-artist` emits real patches
    offline (`demo:badpatch` / `demo:repair` force the failure paths), so all four exits are
    testable with no keys.
  - **`applyPatch` is called with `{ minLength: MIN_ARTIFACT_CHARS }`.** Without it a patch
    can shrink an artifact below the threshold `extractArtifacts` applies: the fence is still
    stored, nothing reads it back, the panel goes blank, and the next turn silently edits the
    PREVIOUS version. Keep the limit wherever a patched result gets stored.
  - Known limitation: `findLiveArtifact` takes artifact index 0 of the newest artifact-bearing
    message, so a reply carrying two artifacts always edits the first. The system prompt asks
    for one, and a patch aimed at the other simply fails into the fallback chain — but if
    multi-artifact replies ever become normal, the client should send the panel's active
    messageId + index with the message instead.
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
  of chat state; components read/write the store. The dashboard has its own
  `client/src/admin/useAdminStore.js` — deliberately separate, because none of its state
  (providers, models, proposals, audit rows) belongs in a chat session, and a non-admin
  must never pay to load it.
- **The dashboard's URL is a secret, and the client is told it at runtime.**
  `/admin` is the first thing a scanner tries, so both the dashboard and its API live
  under a private segment: `config/adminPath.js` resolves it from `ADMIN_PATH`, or
  generates one on first boot and stores it in `AdminSetting.adminPath`. A default
  baked into the repo would be public the moment the repo is — that's why there isn't
  one. Rules that make it actually private:
  - The segment must **never** appear in client source, or it ships in the JS bundle
    and the secrecy is theatre. `GET /api/auth/me` returns `adminPath` **only** when
    `user.role === 'admin'`; that is the one channel. On the client,
    `router.js#setAdminPath` and `client.js#setAdminApiPath` receive it together
    (`useStore#applyAdminPath`), and logout clears both.
  - The API is mounted **last** in `index.js`, on `/api/:adminSegment`, so it cannot
    shadow `/api/models|auth|conversations`. A non-matching segment calls plain
    `next()` — not `next('router')`, which would escape the app router and skip the
    JSON 404 — so a wrong guess is indistinguishable from any other bad path.
  - It is defence in depth, not the lock: `requireAdmin` still runs on every request,
    and the correct segment without a session is a normal 401 (there is no point
    hiding from someone who already has the secret).
  - Because the segment arrives after the first render, a direct hit on the dashboard
    link first parses as a chat route; `App.jsx` re-evaluates `currentRoute()` when
    `adminPath` changes. Don't "simplify" that effect away.
- **Routing**: hand-rolled, no router library — `client/src/lib/router.js` owns the three
  URL shapes (`/` = new chat, `/c/<id>` = a conversation, `/<secret>[/tab]` = the
  dashboard, tabs in `ADMIN_TABS`) and the History API calls. `App.jsx` switches on
  `currentRoute().kind` and renders `client/src/admin/AdminApp.jsx` for `admin`; the chat
  store must not react to an admin route (hence the `kind !== 'admin'` guard before
  `handleRouteChange`). An unknown tab resolves to the overview, not a
  blank screen. For chats the store drives the URL: `selectConversation`/`newChat` push,
  first send of a new chat `replace`s `/` with its permanent link, and `handleRouteChange`
  (wired to `popstate` in `App.jsx`) mirrors Back/Forward. Pass `{ updateUrl: false }`
  when the URL is already the source of truth. A `/c/<id>` that 404s clears to `/` and
  sets `linkError`. Because `pushState` doesn't fire `popstate`, in-app navigation
  announces itself with a `pm:route` event. Deep links rely on the SPA fallback in
  `server/src/index.js` — keep it.
- **Styling**: Tailwind only, dark theme via the `surface-*` palette defined in
  `client/tailwind.config.js` + custom classes in `client/src/index.css`. No CSS files
  per component.
- Server is ESM (`"type": "module"`); always include `.js` extensions in relative imports.
- Don't commit `.env` or `node_modules` (see `.gitignore`). Provider keys live either in
  the `providers` collection (entered in the dashboard, encrypted) or in `server/.env` as
  the fallback — never in the client, which learns availability via `GET /api/models`.
- **Never overwrite `server/.env`** (no `cp .env.example .env` after first setup) — it
  contains the user's real API keys. To add new variables, append/surgically edit lines.
  After any `.env` change, restart the server process. `server/.env` must contain
  `JWT_SECRET`, `ANONYMOUS_MESSAGE_LIMIT`, SMTP settings, and `APP_NAME` for auth to work,
  plus `ADMIN_EMAILS` to get a first admin and ideally a dedicated `ENCRYPTION_KEY`
  (see `server/.env.example`).
  Auth events (register, login, otp sent, password reset, logout, anonymous limit hits)
  are written to the `AuditLog` collection for metrics.

## Conventions

- Node 22+, MongoDB 8. Express 5 is installed — note the SPA fallback in
  `server/src/index.js` uses a middleware, not `app.get('*', ...)` (v5 wildcard syntax
  differs; keep the middleware style).
- Auto-title conversations from the first user message (done server-side in the
  messages route).
- Assistant messages with `error` set are excluded from provider history; keep that
  filter when touching history building.
- **`Markdown.jsx`: keep `MD_COMPONENTS` and the plugin arrays at module scope.** A
  component type (or `components` object) built inside the render is a new type every
  render, so React remounts the whole subtree — while a reply streams, that rebuilt every
  code block on every token and threw away its scroll position. Same file: read code text
  with `lib/codeText.js#codeText`, never `String(children)` — rehype-highlight replaces the
  raw string with `<span>` tokens, and stringifying those gave `[object Object]` to the
  copy button and undercounted the lines the gutter numbers.
- Chat code blocks are capped at `max-h-[26rem]` and scroll internally, with a sticky
  line-number gutter (`.codeblock-*` in `index.css`). The `min-w-max` on the inner `pre` is
  load-bearing: a sticky child only stays pinned inside its containing block, so without it
  the gutter unpins once the code scrolls past one viewport width.
- **Full screen is two mechanisms, and the CSS one is the guarantee.** The button calls
  `requestFullscreen()` *and* sets `.codeblock-expanded` (`fixed inset-0`). Keep both: iOS
  Safari only fullscreens `<video>`, and an embedded/permission-restricted browser rejects
  the call with "Permissions check failed" — the class alone still covers the viewport, so
  the request is fire-and-forget with a swallowed rejection. The `fullscreenchange`
  listener exists because Esc/F11 leave fullscreen without React knowing, and the overlay
  would otherwise stay pinned over the chat.

## Verifying changes

```bash
mongod --version                              # db running?
node server/src/index.js &                    # start API
curl localhost:5050/api/health
curl -s -X POST localhost:5050/api/conversations \
  -H 'Content-Type: application/json' -d '{"modelId":"demo-artist"}'
curl -N -X POST localhost:5050/api/conversations/<id>/messages \
  -H 'Content-Type: application/json' -d '{"content":"hi"}'   # expect SSE stream
npm --prefix client test && npm --prefix server test          # unit tests pass
cd client && npm run build                    # client compiles
```

The conversation endpoints are now owner-scoped. To test anonymously from curl, pass a
consistent `X-Session-Id` header and a cookie jar; to test as a logged-in user, sign up
via `POST /api/auth/register` (triggers an OTP), verify with `POST /api/auth/verify-email`,
then use the returned `auth-token` cookie for subsequent calls.

Admin endpoints need an admin cookie — put the address in `ADMIN_EMAILS` and sign in, or
run `npm --prefix server run make-admin -- <email>`. Then, with that cookie jar:

```bash
curl -s -b jar localhost:5050/api/admin/overview | head -c 400   # registry + encryption health
curl -s -b jar localhost:5050/api/admin/providers                # keySource: db | env | none
# after any write, /api/models must already reflect it — that's reloadRegistry() working
curl -s -b jar -X POST localhost:5050/api/admin/models/bulk-active \
  -H 'Content-Type: application/json' -d '{"slugs":["glm-4.6"],"active":false}'
curl -s localhost:5050/api/models | grep -c glm-4.6                # expect 0
```

To exercise the pricing fetcher offline, serve a fixture HTML file on 127.0.0.1 and set
`ADMIN_FETCH_ALLOW_PRIVATE=1` — that variable disables the SSRF guard, so it is for a
laptop only and must never be set on the server.

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

Published artifact links, with the same `<id>`/`<msg>` from the run above:

```bash
# publish (private) — idempotent, so the same call must return the same publicId
curl -s -b jar -H 'X-Session-Id: s1' -H 'Content-Type: application/json' \
  -X POST localhost:5050/api/artifacts \
  -d '{"conversationId":"<id>","messageId":"<msg>","artifactIndex":0}'
curl -s -o /dev/null -w '%{http_code}\n' localhost:5050/a/<publicId>          # stranger: 404
curl -s -b jar -o /dev/null -w '%{http_code}\n' localhost:5050/a/<publicId>   # owner: 200
curl -s -b jar -H 'Content-Type: application/json' \
  -X PATCH localhost:5050/api/artifacts/<publicId> -d '{"shared":true}'
curl -s localhost:5050/a/<publicId> | grep -c 'allow-same-origin'             # must be 0
```

## Production

Target: Ubuntu + nginx + PM2. Assets/scripts in `deploy/` (keep them in sync with any
port/process changes). SSE requires `proxy_buffering off` on `/api/` (already in
`deploy/nginx.conf`).
