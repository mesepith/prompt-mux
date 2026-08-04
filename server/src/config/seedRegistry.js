/**
 * Seed registry — the built-in defaults for companies and models.
 *
 * This file is NOT the runtime source of truth any more: `config/registry.js`
 * loads companies and models from MongoDB (collections `providers` and
 * `llmmodels`), which the admin dashboard edits. This file is what those
 * collections are *seeded* from on an empty database, and what
 * `POST /api/admin/registry/reseed` restores missing entries from.
 *
 * Seeding is upsert-on-insert only: an entry that already exists in the DB is
 * never overwritten, so an admin's edits always win over these defaults.
 *
 * Company fields:
 *   - id:          stable slug, referenced by every model's `company`
 *   - name:        display name
 *   - envKey:      env var checked as a fallback when no key is stored in the DB
 *   - baseURL:     API base URL (OpenAI-compatible providers); null = SDK default
 *   - baseUrlEnv:  env var that overrides baseURL
 *   - adapter:     which provider adapter drives it — 'openai' | 'anthropic' |
 *                  'google' | 'demo'. Most vendors ship an OpenAI-compatible API,
 *                  so a brand-new company can be added from the dashboard with
 *                  adapter 'openai' + its baseURL and no code change.
 *   - requiresKey: false only for Demo, which needs no credentials
 *   - pricingUrl:  page the "fetch latest prices" tool reads
 *   - docsUrl:     API docs, shown as a link in the dashboard
 *   - color:       accent colour used across the UI
 *
 * Model fields:
 *   - id / company / name / apiModel / tagline
 *   - price:  USD per 1M tokens { in, out } — drives the cost estimate in the UI
 *   - vision: accepts image input
 *   - pdf:    accepts native PDF input (all false today — PDFs are rendered to
 *             images and read by the vision model)
 *   - contextWindow / maxOutput: informational, shown in the dashboard
 *   - pricingUrl: per-model pricing page, overrides the company's
 */
export const SEED_COMPANIES = [
  {
    id: 'openai',
    name: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    adapter: 'openai',
    baseURL: null,
    baseUrlEnv: null,
    requiresKey: true,
    // Two traps here, both verified 2026-08-04. The marketing page
    // (openai.com/api/pricing) 403s any non-browser client. And the rendered docs
    // page hides the unit in a table header, so the `.md` twin — which every
    // developers.openai.com page has — is both cleaner and cheaper to extract.
    pricingUrl: 'https://developers.openai.com/api/docs/pricing.md',
    docsUrl: 'https://developers.openai.com/api/docs/models',
    color: '#10a37f',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    adapter: 'anthropic',
    baseURL: null,
    baseUrlEnv: null,
    requiresKey: true,
    // claude.com/pricing renders in the browser; the docs page ships the table,
    // and its `.md` twin ships it even cleaner.
    pricingUrl: 'https://platform.claude.com/docs/en/about-claude/pricing.md',
    docsUrl: 'https://platform.claude.com/docs/en/about-claude/models/overview',
    color: '#d97757',
  },
  {
    id: 'google',
    name: 'Google',
    envKey: 'GOOGLE_API_KEY',
    adapter: 'google',
    baseURL: null,
    baseUrlEnv: null,
    requiresKey: true,
    pricingUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
    docsUrl: 'https://ai.google.dev/gemini-api/docs',
    color: '#4285f4',
  },
  {
    id: 'moonshot',
    name: 'Moonshot AI',
    envKey: 'MOONSHOT_API_KEY',
    adapter: 'openai',
    baseURL: 'https://api.moonshot.ai/v1',
    baseUrlEnv: 'MOONSHOT_BASE_URL',
    requiresKey: true,
    // Kimi prices per model family, not on one company page, so the URLs live on
    // the models below and there is no company-level page to fetch. The rendered
    // HTML carries no amounts at all; only the `.md` twin does, as MDX.
    pricingUrl: null,
    docsUrl: 'https://platform.kimi.ai/docs',
    color: '#8b5cf6',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    envKey: 'DEEPSEEK_API_KEY',
    adapter: 'openai',
    baseURL: 'https://api.deepseek.com',
    baseUrlEnv: 'DEEPSEEK_BASE_URL',
    requiresKey: true,
    pricingUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
    docsUrl: 'https://api-docs.deepseek.com',
    color: '#4d6bfe',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    envKey: 'MISTRAL_API_KEY',
    adapter: 'openai',
    baseURL: 'https://api.mistral.ai/v1',
    baseUrlEnv: 'MISTRAL_BASE_URL',
    requiresKey: true,
    pricingUrl: 'https://mistral.ai/pricing/api/',
    docsUrl: 'https://docs.mistral.ai',
    color: '#f97316',
  },
  {
    id: 'zai',
    name: 'Z.ai (GLM)',
    envKey: 'ZAI_API_KEY',
    adapter: 'openai',
    baseURL: 'https://api.z.ai/api/paas/v4',
    baseUrlEnv: 'ZAI_BASE_URL',
    requiresKey: true,
    pricingUrl: 'https://docs.z.ai/guides/overview/pricing',
    docsUrl: 'https://docs.z.ai',
    color: '#22d3ee',
  },
  {
    id: 'demo',
    name: 'Demo (no key needed)',
    envKey: null,
    adapter: 'demo',
    baseURL: null,
    baseUrlEnv: null,
    requiresKey: false,
    pricingUrl: null,
    docsUrl: null,
    color: '#a1a1aa',
  },
];

export const SEED_MODELS = [
  // --- OpenAI (GPT-5.6 family, verified against developers.openai.com 2026-08-04) ---
  { id: 'gpt-5.6-sol', company: 'openai', name: 'GPT-5.6 Sol', apiModel: 'gpt-5.6-sol', tagline: 'Frontier model for complex professional work', price: { in: 5.0, out: 30.0 }, vision: true, pdf: true, contextWindow: 1_050_000, maxOutput: 128_000 },
  { id: 'gpt-5.6-terra', company: 'openai', name: 'GPT-5.6 Terra', apiModel: 'gpt-5.6-terra', tagline: 'Balances intelligence and cost', price: { in: 2.0, out: 12.0 }, vision: true, pdf: true, contextWindow: 1_050_000, maxOutput: 128_000 },
  { id: 'gpt-5.6-luna', company: 'openai', name: 'GPT-5.6 Luna', apiModel: 'gpt-5.6-luna', tagline: 'Optimized for cost-sensitive workloads', price: { in: 0.2, out: 1.2 }, vision: true, pdf: true, contextWindow: 1_050_000, maxOutput: 128_000 },

  // --- Anthropic (verified against platform.claude.com 2026-08-04) ---
  // Model ids from the 4.6 generation on are dateless but still pinned snapshots,
  // not evergreen pointers — Haiku 4.5 predates that, hence its dated id.
  { id: 'claude-fable-5', company: 'anthropic', name: 'Claude Fable 5', apiModel: 'claude-fable-5', tagline: 'Next-generation intelligence for long-running agents', price: { in: 10.0, out: 50.0 }, vision: true, pdf: true, contextWindow: 1_000_000, maxOutput: 128_000 },
  { id: 'claude-opus-5', company: 'anthropic', name: 'Claude Opus 5', apiModel: 'claude-opus-5', tagline: 'For complex agentic coding and enterprise work', price: { in: 5.0, out: 25.0 }, vision: true, pdf: true, contextWindow: 1_000_000, maxOutput: 128_000 },
  // Introductory pricing of $2/$10 runs to 2026-08-31; the standard rate is $3/$15.
  { id: 'claude-sonnet-5', company: 'anthropic', name: 'Claude Sonnet 5', apiModel: 'claude-sonnet-5', tagline: 'Best combination of speed and intelligence', price: { in: 2.0, out: 10.0 }, vision: true, pdf: true, contextWindow: 1_000_000, maxOutput: 128_000, notes: 'Introductory pricing $2/$10 per 1M tokens until 2026-08-31, then $3/$15. Update the price on 1 September.' },
  { id: 'claude-haiku-4.5', company: 'anthropic', name: 'Claude Haiku 4.5', apiModel: 'claude-haiku-4-5-20251001', tagline: 'Fastest model with near-frontier intelligence', price: { in: 1.0, out: 5.0 }, vision: true, pdf: true, contextWindow: 200_000, maxOutput: 64_000 },

  // --- Google ---
  // Gemini 2.x is gone: 2.5-flash 404s ("no longer available to new users") and
  // 2.0-flash / 2.5-pro return 429 with `limit: 0` — no free-tier quota is allocated
  // for them any more. Pro-class models have no free tier at all, so they are omitted
  // here; add gemini-3.1-pro-preview ($2/$12) only once billing is enabled.
  { id: 'gemini-3.6-flash', company: 'google', name: 'Gemini 3.6 Flash', apiModel: 'gemini-3.6-flash', tagline: 'Flagship Flash', price: { in: 1.5, out: 7.5 }, vision: true, pdf: true, contextWindow: 1_048_576, maxOutput: 65_536 },
  { id: 'gemini-3.1-flash-lite', company: 'google', name: 'Gemini 3.1 Flash-Lite', apiModel: 'gemini-3.1-flash-lite', tagline: 'Fast and cheapest', price: { in: 0.25, out: 1.5 }, vision: true, pdf: true, contextWindow: 1_048_576, maxOutput: 65_536 },
  // Measured 2026-07-29 to stall forever on roughly 2 of 3 calls under the deprecated
  // @google/generative-ai SDK: no chunk, no throw, no completion. It is listed because
  // it was asked for, and it is now survivable rather than fatal — providers/google.js
  // enforces a stream idle timeout, so a stall surfaces as an error in the transcript
  // instead of spinning until nginx gives up at 600s. The real fix is migrating this
  // provider to @google/genai.
  { id: 'gemini-3.5-flash-lite', company: 'google', name: 'Gemini 3.5 Flash-Lite', apiModel: 'gemini-3.5-flash-lite', tagline: 'Fastest, most cost-effective 3.5', price: { in: 0.3, out: 2.5 }, vision: true, pdf: true, contextWindow: 1_048_576, maxOutput: 65_536, notes: 'Known to stall mid-stream under the current Google SDK (~2 of 3 calls as of 2026-07-29). A stall now fails with a timeout rather than hanging. Prefer Gemini 3.6 Flash or 3.1 Flash-Lite for anything important.' },

  // --- Moonshot AI (Kimi) ---
  // Each of these points at its own pricing page — the `.md` twin, because the
  // rendered page draws the table in the browser. chat-k27-code covers both K2.7
  // variants. Context windows below match those pages. Verified 2026-08-04.
  { id: 'kimi-k3', company: 'moonshot', name: 'Kimi K3', apiModel: 'kimi-k3', tagline: 'Flagship, 1M context', price: { in: 3.0, out: 15.0, cachedIn: 0.3 }, vision: true, pdf: false, contextWindow: 1_048_576, maxOutput: 32_768, pricingUrl: 'https://platform.kimi.ai/docs/pricing/chat-k3.md' },
  { id: 'kimi-k2.7-code', company: 'moonshot', name: 'Kimi K2.7 Code', apiModel: 'kimi-k2.7-code', tagline: 'Dedicated coding model, 256k', price: { in: 0.95, out: 4.0, cachedIn: 0.19 }, vision: true, pdf: false, contextWindow: 262_144, maxOutput: 32_768, pricingUrl: 'https://platform.kimi.ai/docs/pricing/chat-k27-code.md' },
  { id: 'kimi-k2.7-code-highspeed', company: 'moonshot', name: 'Kimi K2.7 Code HS', apiModel: 'kimi-k2.7-code-highspeed', tagline: '~180 tok/s coding', price: { in: 1.9, out: 8.0, cachedIn: 0.38 }, vision: true, pdf: false, contextWindow: 262_144, maxOutput: 32_768, pricingUrl: 'https://platform.kimi.ai/docs/pricing/chat-k27-code.md' },
  { id: 'kimi-k2.6', company: 'moonshot', name: 'Kimi K2.6', apiModel: 'kimi-k2.6', tagline: 'Multimodal, 256k', price: { in: 0.95, out: 4.0, cachedIn: 0.16 }, vision: true, pdf: false, contextWindow: 262_144, maxOutput: 32_768, pricingUrl: 'https://platform.kimi.ai/docs/pricing/chat-k26.md' },

  // --- DeepSeek (text-only — pair with a vision model for images) ---
  { id: 'deepseek-v4-pro', company: 'deepseek', name: 'DeepSeek V4 Pro', apiModel: 'deepseek-v4-pro', tagline: 'Flagship, 1M context', price: { in: 0.435, out: 0.87 }, vision: false, pdf: false, contextWindow: 1_000_000, maxOutput: 65_536 },
  { id: 'deepseek-v4-flash', company: 'deepseek', name: 'DeepSeek V4 Flash', apiModel: 'deepseek-v4-flash', tagline: 'Fast and very cheap, 1M context', price: { in: 0.14, out: 0.28 }, vision: false, pdf: false, contextWindow: 1_000_000, maxOutput: 65_536 },

  // --- Mistral (prices verified against mistral.ai/pricing/api/ 2026-08-04;
  //     Small 4, Large 3 and Ministral 8B were all stale before that) ---
  { id: 'mistral-medium-3.5', company: 'mistral', name: 'Mistral Medium 3.5', apiModel: 'mistral-medium-2604', tagline: 'Frontier multimodal, coding', price: { in: 1.5, out: 7.5 }, vision: true, pdf: true, contextWindow: 128_000, maxOutput: 32_768 },
  { id: 'mistral-small-4', company: 'mistral', name: 'Mistral Small 4', apiModel: 'mistral-small-2603', tagline: 'Instruct + reasoning + coding', price: { in: 0.15, out: 0.6 }, vision: true, pdf: true, contextWindow: 128_000, maxOutput: 32_768 },
  { id: 'mistral-large-3', company: 'mistral', name: 'Mistral Large 3', apiModel: 'mistral-large-2512', tagline: 'Open-weight general purpose', price: { in: 0.5, out: 1.5 }, vision: true, pdf: true, contextWindow: 256_000, maxOutput: 32_768 },
  { id: 'codestral', company: 'mistral', name: 'Codestral', apiModel: 'codestral-2508', tagline: 'Code completion specialist', price: { in: 0.3, out: 0.9 }, vision: false, pdf: false, contextWindow: 256_000, maxOutput: 32_768 },
  { id: 'ministral-3-8b', company: 'mistral', name: 'Ministral 3 8B', apiModel: 'ministral-8b-2512', tagline: 'Efficient, small-footprint', price: { in: 0.15, out: 0.15 }, vision: true, pdf: true, contextWindow: 128_000, maxOutput: 32_768 },

  // --- Z.ai (GLM) ---
  { id: 'glm-5.2', company: 'zai', name: 'GLM-5.2', apiModel: 'glm-5.2', tagline: 'Latest flagship', price: { in: 1.4, out: 4.4 }, vision: false, pdf: false, contextWindow: 200_000, maxOutput: 32_768 },
  { id: 'glm-5-turbo', company: 'zai', name: 'GLM-5-Turbo', apiModel: 'glm-5-turbo', tagline: 'Built for coding agents', price: { in: 1.2, out: 4.0 }, vision: false, pdf: false, contextWindow: 200_000, maxOutput: 32_768 },
  { id: 'glm-4.7', company: 'zai', name: 'GLM-4.7', apiModel: 'glm-4.7', tagline: 'Great value all-rounder', price: { in: 0.6, out: 2.2 }, vision: false, pdf: false, contextWindow: 200_000, maxOutput: 32_768 },
  { id: 'glm-4.6', company: 'zai', name: 'GLM-4.6', apiModel: 'glm-4.6', tagline: 'Previous-gen workhorse', price: { in: 0.6, out: 2.2 }, vision: false, pdf: false, contextWindow: 200_000, maxOutput: 32_768 },
  { id: 'glm-4.5-flash', company: 'zai', name: 'GLM-4.5-Flash', apiModel: 'glm-4.5-flash', tagline: 'Free tier', price: { in: 0, out: 0 }, vision: false, pdf: false, contextWindow: 128_000, maxOutput: 16_384 },
  { id: 'glm-4.6v', company: 'zai', name: 'GLM-4.6V', apiModel: 'glm-4.6v', tagline: 'Vision model — great for the image slot', price: { in: 0.3, out: 0.9 }, vision: true, pdf: false, contextWindow: 64_000, maxOutput: 16_384 },
  { id: 'glm-4.6v-flash', company: 'zai', name: 'GLM-4.6V-Flash', apiModel: 'glm-4.6v-flash', tagline: 'Free vision model', price: { in: 0, out: 0 }, vision: true, pdf: false, contextWindow: 64_000, maxOutput: 16_384 },

  // --- Demo (works without any API key, streams a sample artifact) ---
  { id: 'demo-artist', company: 'demo', name: 'Demo Artist', apiModel: 'demo-artist', tagline: 'Offline demo with live artifact', price: { in: 0, out: 0 }, vision: false, pdf: false, contextWindow: null, maxOutput: null },
  { id: 'demo-vision', company: 'demo', name: 'Demo Vision', apiModel: 'demo-vision', tagline: 'Offline demo image describer', price: { in: 0, out: 0 }, vision: true, pdf: false, contextWindow: null, maxOutput: null },
];

/** Adapters the provider router knows how to drive. */
export const ADAPTERS = ['openai', 'anthropic', 'google', 'demo'];
