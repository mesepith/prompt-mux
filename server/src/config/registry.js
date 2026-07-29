/**
 * Model registry — the single source of truth for companies and models.
 *
 * To add a new model (e.g. "ChatGPT 5.5", "Claude Opus 4.8", "Gemini Flash 3.1"),
 * just add an entry to MODELS below:
 *   - id:        unique slug used across the app
 *   - company:   must match a company id in COMPANIES
 *   - name:      display name shown in the UI
 *   - apiModel:  the exact model id the provider's API expects
 *   - tagline:   short description shown in the model picker
 *   - price:     USD per 1M tokens { in, out } — used for the cost estimate in the UI.
 *                Keep in sync with each provider's pricing page. Omit for no cost display.
 *   - vision:    true if the model accepts image input. When the selected chat model
 *                has vision: false, attached images are handled by a separate
 *                vision-capable model (conversation.visionModelId).
 *   - pdf:       true if the model accepts native PDF input (in-chat, not Files API).
 *                When pdf: false, PDFs are rendered to images server-side and the
 *                vision model reads them. Currently false for all — rendered pages
 *                are fed through the same vision-model flow as images.
 */
export const COMPANIES = [
  {
    id: 'openai',
    name: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    color: '#10a37f',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    color: '#d97757',
  },
  {
    id: 'google',
    name: 'Google',
    envKey: 'GOOGLE_API_KEY',
    color: '#4285f4',
  },
  {
    id: 'moonshot',
    name: 'Moonshot AI',
    envKey: 'MOONSHOT_API_KEY',
    color: '#8b5cf6',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    envKey: 'DEEPSEEK_API_KEY',
    color: '#4d6bfe',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    envKey: 'MISTRAL_API_KEY',
    color: '#f97316',
  },
  {
    id: 'zai',
    name: 'Z.ai (GLM)',
    envKey: 'ZAI_API_KEY',
    color: '#22d3ee',
  },
  {
    id: 'demo',
    name: 'Demo (no key needed)',
    envKey: null,
    color: '#a1a1aa',
  },
];

export const MODELS = [
  // --- OpenAI ---
  { id: 'gpt-4.1', company: 'openai', name: 'GPT-4.1', apiModel: 'gpt-4.1', tagline: 'Flagship, great for coding', price: { in: 2.0, out: 8.0 }, vision: true, pdf: true },
  { id: 'gpt-4.1-mini', company: 'openai', name: 'GPT-4.1 mini', apiModel: 'gpt-4.1-mini', tagline: 'Fast and affordable', price: { in: 0.4, out: 1.6 }, vision: true, pdf: true },
  { id: 'gpt-4o', company: 'openai', name: 'GPT-4o', apiModel: 'gpt-4o', tagline: 'Multimodal all-rounder', price: { in: 2.5, out: 10.0 }, vision: true, pdf: true },
  // Example for future models — point apiModel at the real API id when released:
  // { id: 'chatgpt-5.5', company: 'openai', name: 'ChatGPT 5.5', apiModel: 'gpt-5.5', tagline: 'Next-gen flagship' },

  // --- Anthropic ---
  { id: 'claude-opus-4', company: 'anthropic', name: 'Claude Opus 4', apiModel: 'claude-opus-4-20250514', tagline: 'Most capable Claude', price: { in: 15.0, out: 75.0 }, vision: true, pdf: true },
  { id: 'claude-sonnet-4', company: 'anthropic', name: 'Claude Sonnet 4', apiModel: 'claude-sonnet-4-20250514', tagline: 'Balanced speed & quality', price: { in: 3.0, out: 15.0 }, vision: true, pdf: true },
  { id: 'claude-3.5-haiku', company: 'anthropic', name: 'Claude 3.5 Haiku', apiModel: 'claude-3-5-haiku-20241022', tagline: 'Fastest Claude', price: { in: 0.8, out: 4.0 }, vision: true, pdf: true },

  // --- Google ---
  { id: 'gemini-2.5-pro', company: 'google', name: 'Gemini 2.5 Pro', apiModel: 'gemini-2.5-pro', tagline: 'Top reasoning, long context', price: { in: 1.25, out: 10.0 }, vision: true, pdf: true },
  { id: 'gemini-2.5-flash', company: 'google', name: 'Gemini 2.5 Flash', apiModel: 'gemini-2.5-flash', tagline: 'Fast, great value', price: { in: 0.3, out: 2.5 }, vision: true, pdf: true },
  { id: 'gemini-2.0-flash', company: 'google', name: 'Gemini 2.0 Flash', apiModel: 'gemini-2.0-flash', tagline: 'Previous-gen speedster', price: { in: 0.1, out: 0.4 }, vision: true, pdf: true },

  // --- Moonshot AI (Kimi) ---
  { id: 'kimi-k3', company: 'moonshot', name: 'Kimi K3', apiModel: 'kimi-k3', tagline: 'Flagship, 1M context', price: { in: 3.0, out: 15.0 }, vision: true, pdf: false },
  { id: 'kimi-k2.7-code', company: 'moonshot', name: 'Kimi K2.7 Code', apiModel: 'kimi-k2.7-code', tagline: 'Dedicated coding model, 256k', price: { in: 0.95, out: 4.0 }, vision: true, pdf: false },
  { id: 'kimi-k2.7-code-highspeed', company: 'moonshot', name: 'Kimi K2.7 Code HS', apiModel: 'kimi-k2.7-code-highspeed', tagline: '~180 tok/s coding', price: { in: 1.9, out: 8.0 }, vision: true, pdf: false },
  { id: 'kimi-k2.6', company: 'moonshot', name: 'Kimi K2.6', apiModel: 'kimi-k2.6', tagline: 'Multimodal, 256k', price: { in: 0.95, out: 4.0 }, vision: true, pdf: false },

  // --- DeepSeek (text-only — pair with a vision model for images) ---
  { id: 'deepseek-v4-pro', company: 'deepseek', name: 'DeepSeek V4 Pro', apiModel: 'deepseek-v4-pro', tagline: 'Flagship, 1M context', price: { in: 0.435, out: 0.87 }, vision: false, pdf: false },
  { id: 'deepseek-v4-flash', company: 'deepseek', name: 'DeepSeek V4 Flash', apiModel: 'deepseek-v4-flash', tagline: 'Fast and very cheap, 1M context', price: { in: 0.14, out: 0.28 }, vision: false, pdf: false },

  // --- Mistral ---
  { id: 'mistral-medium-3.5', company: 'mistral', name: 'Mistral Medium 3.5', apiModel: 'mistral-medium-2604', tagline: 'Frontier multimodal, coding', price: { in: 1.5, out: 7.5 }, vision: true, pdf: true },
  { id: 'mistral-small-4', company: 'mistral', name: 'Mistral Small 4', apiModel: 'mistral-small-2603', tagline: 'Instruct + reasoning + coding', price: { in: 0.3, out: 0.9 }, vision: true, pdf: true },
  { id: 'mistral-large-3', company: 'mistral', name: 'Mistral Large 3', apiModel: 'mistral-large-2512', tagline: 'Open-weight general purpose', price: { in: 2.0, out: 6.0 }, vision: true, pdf: true },
  { id: 'codestral', company: 'mistral', name: 'Codestral', apiModel: 'codestral-2508', tagline: 'Code completion specialist', price: { in: 0.3, out: 0.9 }, vision: false, pdf: false },
  { id: 'ministral-3-8b', company: 'mistral', name: 'Ministral 3 8B', apiModel: 'ministral-8b-2512', tagline: 'Efficient, small-footprint', price: { in: 0.1, out: 0.1 }, vision: true, pdf: true },

  // --- Z.ai (GLM) ---
  { id: 'glm-5.2', company: 'zai', name: 'GLM-5.2', apiModel: 'glm-5.2', tagline: 'Latest flagship', price: { in: 1.4, out: 4.4 }, vision: false, pdf: false },
  { id: 'glm-5-turbo', company: 'zai', name: 'GLM-5-Turbo', apiModel: 'glm-5-turbo', tagline: 'Built for coding agents', price: { in: 1.2, out: 4.0 }, vision: false, pdf: false },
  { id: 'glm-4.7', company: 'zai', name: 'GLM-4.7', apiModel: 'glm-4.7', tagline: 'Great value all-rounder', price: { in: 0.6, out: 2.2 }, vision: false, pdf: false },
  { id: 'glm-4.6', company: 'zai', name: 'GLM-4.6', apiModel: 'glm-4.6', tagline: 'Previous-gen workhorse', price: { in: 0.6, out: 2.2 }, vision: false, pdf: false },
  { id: 'glm-4.5-flash', company: 'zai', name: 'GLM-4.5-Flash', apiModel: 'glm-4.5-flash', tagline: 'Free tier', price: { in: 0, out: 0 }, vision: false, pdf: false },
  { id: 'glm-4.6v', company: 'zai', name: 'GLM-4.6V', apiModel: 'glm-4.6v', tagline: 'Vision model — great for the image slot', price: { in: 0.3, out: 0.9 }, vision: true, pdf: false },
  { id: 'glm-4.6v-flash', company: 'zai', name: 'GLM-4.6V-Flash', apiModel: 'glm-4.6v-flash', tagline: 'Free vision model', price: { in: 0, out: 0 }, vision: true, pdf: false },

  // --- Demo (works without any API key, streams a sample artifact) ---
  { id: 'demo-artist', company: 'demo', name: 'Demo Artist', apiModel: 'demo-artist', tagline: 'Offline demo with live artifact', price: { in: 0, out: 0 }, vision: false, pdf: false },
  { id: 'demo-vision', company: 'demo', name: 'Demo Vision', apiModel: 'demo-vision', tagline: 'Offline demo image describer', price: { in: 0, out: 0 }, vision: true, pdf: false },
];

export const getModel = (modelId) => MODELS.find((m) => m.id === modelId);
export const getCompany = (companyId) => COMPANIES.find((c) => c.id === companyId);
export const isCompanyAvailable = (company) =>
  !company.envKey || Boolean(process.env[company.envKey]);
