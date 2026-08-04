/**
 * Model registry — the runtime source of truth for companies and models.
 *
 * Companies and models live in MongoDB (`providers` / `llmmodels`) and are edited
 * from the admin dashboard. This module holds them in an in-process cache so the
 * rest of the app can keep asking synchronous questions ("what is model X?",
 * "does this company have a key?") in the middle of a request or an SSE stream.
 *
 * Shape contract: `getCompany()` / `getModel()` / `listCompanies()` /
 * `listModels()` return exactly the plain objects the client has always seen
 * (`company.id`, `model.company`, `model.price = { in, out }`), so nothing
 * downstream cares that the data now comes from a database.
 *
 * Two rules worth keeping:
 *  1. **API keys are never part of a cached company object.** They live in a
 *     separate private map, so `res.json(company)` can never leak one. Ask for a
 *     key explicitly via `resolveApiKey()`.
 *  2. **Every admin mutation must call `reloadRegistry()`**, otherwise the
 *     process keeps serving the old registry until it restarts.
 *
 * config/seedRegistry.js holds the built-in defaults used to seed an empty
 * database, and is also the fallback if the DB can't be read at boot — a broken
 * Mongo query should degrade the app to "the defaults", not to "no models".
 */
import { Provider } from '../models/Provider.js';
import { LlmModel } from '../models/LlmModel.js';
import { SEED_COMPANIES, SEED_MODELS } from './seedRegistry.js';
import { decryptSecret } from '../lib/secrets.js';

// --- cache ---------------------------------------------------------------

let companies = []; // public company objects, ordered
let models = []; // public model objects, ordered
const companyById = new Map();
const modelById = new Map();
const apiKeys = new Map(); // companyId -> plaintext key, PRIVATE to this module
let loadedAt = null;
let usingFallback = true;

/** Normalizes a stored/seeded company into the object the app passes around. */
function toPublicCompany(doc) {
  return {
    id: doc.slug || doc.id,
    name: doc.name,
    adapter: doc.adapter || 'openai',
    envKey: doc.envKey ?? null,
    baseURL: doc.baseURL ?? null,
    baseUrlEnv: doc.baseUrlEnv ?? null,
    requiresKey: doc.requiresKey !== false,
    color: doc.color || '#71717a',
    pricingUrl: doc.pricingUrl ?? null,
    docsUrl: doc.docsUrl ?? null,
    notes: doc.notes ?? null,
    active: doc.active !== false,
    sortOrder: typeof doc.sortOrder === 'number' ? doc.sortOrder : 100,
  };
}

/** Normalizes a stored/seeded model. `price` is omitted unless both rates exist. */
function toPublicModel(doc) {
  const rawIn = doc.price?.in;
  const rawOut = doc.price?.out;
  const priced = typeof rawIn === 'number' && typeof rawOut === 'number';
  return {
    id: doc.slug || doc.id,
    company: doc.company,
    name: doc.name,
    apiModel: doc.apiModel,
    tagline: doc.tagline ?? null,
    // Omitted when unpriced: the client treats a missing `price` as "show tokens
    // only", and a half-filled { in: null } would compute NaN costs.
    ...(priced
      ? {
          price: {
            in: rawIn,
            out: rawOut,
            ...(typeof doc.price?.cachedIn === 'number' ? { cachedIn: doc.price.cachedIn } : {}),
          },
        }
      : {}),
    currency: doc.currency || 'USD',
    priceSource: doc.priceSource || 'seed',
    priceUpdatedAt: doc.priceUpdatedAt ?? null,
    vision: Boolean(doc.vision),
    pdf: Boolean(doc.pdf),
    contextWindow: doc.contextWindow ?? null,
    maxOutput: doc.maxOutput ?? null,
    pricingUrl: doc.pricingUrl ?? null,
    active: doc.active !== false,
    sortOrder: typeof doc.sortOrder === 'number' ? doc.sortOrder : 100,
  };
}

function applyCache({ companyList, modelList, fallback }) {
  companies = companyList;
  models = modelList;
  companyById.clear();
  modelById.clear();
  for (const c of companies) companyById.set(c.id, c);
  for (const m of models) modelById.set(m.id, m);
  usingFallback = Boolean(fallback);
  loadedAt = new Date();
}

/** Seed defaults, used before the first successful DB load and if one fails. */
function loadFallback() {
  applyCache({
    companyList: SEED_COMPANIES.map((c, i) => toPublicCompany({ ...c, sortOrder: i * 10 })),
    modelList: SEED_MODELS.map((m, i) => toPublicModel({ ...m, sortOrder: i * 10 })),
    fallback: true,
  });
  apiKeys.clear();
}

loadFallback();

// --- loading -------------------------------------------------------------

/**
 * Refreshes the cache from MongoDB. Call at boot and after every admin write.
 * Returns { companies, models } counts. On failure the previous cache is kept
 * (or the seed defaults, if nothing was ever loaded) and the error is rethrown.
 */
export async function reloadRegistry() {
  // apiKeyEncrypted is `select: false` on the schema — ask for it explicitly.
  const providerDocs = await Provider.find({})
    .select('+apiKeyEncrypted')
    .sort({ sortOrder: 1, name: 1 })
    .lean();
  const modelDocs = await LlmModel.find({}).sort({ sortOrder: 1, name: 1 }).lean();

  if (!providerDocs.length && !modelDocs.length) {
    // Empty database (e.g. seeding failed). Keep the defaults rather than
    // serving an app with no models at all.
    loadFallback();
    return { companies: companies.length, models: models.length, fallback: true };
  }

  applyCache({
    companyList: providerDocs.map(toPublicCompany),
    modelList: modelDocs.map(toPublicModel),
    fallback: false,
  });

  apiKeys.clear();
  for (const doc of providerDocs) {
    if (!doc.apiKeyEncrypted) continue;
    const plain = decryptSecret(doc.apiKeyEncrypted);
    if (plain) apiKeys.set(doc.slug, plain);
  }

  return { companies: companies.length, models: models.length, fallback: false };
}

/**
 * Inserts any seed company/model that isn't in the DB yet. Existing rows are
 * left completely alone, so an admin's edits are never clobbered by a restart
 * or a redeploy. Returns what it created.
 */
export async function seedRegistry() {
  const existingProviders = new Set((await Provider.find({}).select('slug').lean()).map((p) => p.slug));
  const existingModels = new Set((await LlmModel.find({}).select('slug').lean()).map((m) => m.slug));

  const newProviders = SEED_COMPANIES.filter((c) => !existingProviders.has(c.id)).map((c, i) => ({
    slug: c.id,
    name: c.name,
    adapter: c.adapter,
    envKey: c.envKey,
    baseURL: c.baseURL,
    baseUrlEnv: c.baseUrlEnv,
    requiresKey: c.requiresKey,
    color: c.color,
    pricingUrl: c.pricingUrl,
    docsUrl: c.docsUrl,
    active: true,
    sortOrder: (existingProviders.size + i) * 10,
  }));

  const newModels = SEED_MODELS.filter((m) => !existingModels.has(m.id)).map((m, i) => ({
    slug: m.id,
    company: m.company,
    name: m.name,
    apiModel: m.apiModel,
    tagline: m.tagline,
    price: {
      in: m.price?.in ?? null,
      out: m.price?.out ?? null,
      cachedIn: null,
    },
    currency: 'USD',
    priceSource: 'seed',
    vision: Boolean(m.vision),
    pdf: Boolean(m.pdf),
    contextWindow: m.contextWindow ?? null,
    maxOutput: m.maxOutput ?? null,
    // Carried through so a seed entry can ship a caveat (an introductory price
    // that expires, a model with a known SDK bug) instead of losing it on insert.
    pricingUrl: m.pricingUrl ?? null,
    notes: m.notes ?? null,
    active: true,
    sortOrder: (existingModels.size + i) * 10,
  }));

  if (newProviders.length) await Provider.insertMany(newProviders, { ordered: false });
  if (newModels.length) await LlmModel.insertMany(newModels, { ordered: false });

  return { companies: newProviders.length, models: newModels.length };
}

/** Boot helper: seed what's missing, then load. Never throws — logs and falls back. */
export async function initRegistry() {
  // Seeding is best-effort and isolated from loading: a duplicate-key race
  // between two starting processes must not stop us from serving the registry
  // that is already in the database.
  try {
    const seeded = await seedRegistry();
    if (seeded.companies || seeded.models) {
      console.log(
        `[registry] seeded ${seeded.companies} company/companies and ${seeded.models} model(s) from the defaults`
      );
    }
  } catch (err) {
    console.error(`[registry] seeding skipped: ${err.message}`);
  }

  try {
    const loaded = await reloadRegistry();
    console.log(
      `[registry] loaded ${loaded.companies} companies and ${loaded.models} models from MongoDB`
    );
    return loaded;
  } catch (err) {
    console.error(
      `[registry] could not load from MongoDB (${err.message}) — falling back to the built-in defaults`
    );
    loadFallback();
    return { companies: companies.length, models: models.length, fallback: true };
  }
}

/** Diagnostics for the dashboard health panel. */
export function registryStatus() {
  return {
    loadedAt,
    usingFallback,
    companies: companies.length,
    models: models.length,
    activeCompanies: companies.filter((c) => c.active).length,
    activeModels: models.filter((m) => m.active).length,
    keysInDb: apiKeys.size,
  };
}

// --- lookups -------------------------------------------------------------

/**
 * All companies. Inactive ones are hidden by default: the chat UI must not offer
 * a company an admin switched off, while the dashboard passes includeInactive.
 */
export function listCompanies({ includeInactive = false } = {}) {
  return includeInactive ? [...companies] : companies.filter((c) => c.active);
}

export function listModels({ includeInactive = false } = {}) {
  if (includeInactive) return [...models];
  const activeCompanies = new Set(companies.filter((c) => c.active).map((c) => c.id));
  return models.filter((m) => m.active && activeCompanies.has(m.company));
}

/**
 * Looks up a model regardless of `active`. Deliberate: an existing conversation
 * can reference a model an admin has since switched off, and "this model was
 * disabled" is a far better error than "Unknown modelId". `streamChat` is what
 * enforces active-ness at call time.
 */
export function getModel(modelId) {
  return modelById.get(modelId) || null;
}

export function getCompany(companyId) {
  return companyById.get(companyId) || null;
}

/** Models belonging to one company (all of them, active or not). */
export function modelsForCompany(companyId) {
  return models.filter((m) => m.company === companyId);
}

/**
 * Why a model may not be chosen for a new conversation (or switched to), or null
 * when it's fine. Used where a clear 400 beats letting the request reach the
 * provider — creating a chat, changing a chat's model.
 */
export function modelUnavailableReason(model) {
  if (!model) return 'Unknown modelId';
  const company = getCompany(model.company);
  if (!company) return `Unknown company: ${model.company}`;
  if (!model.active) return `${model.name} is currently disabled.`;
  if (!company.active) return `${company.name} is currently disabled.`;
  return null;
}

// --- credentials ---------------------------------------------------------

/**
 * The API key for a company: the one stored in the DB wins, the env var is the
 * fallback. Returns null when neither is set. This is the ONLY way to get a key
 * out of the registry.
 */
export function resolveApiKey(company) {
  if (!company) return null;
  const stored = apiKeys.get(company.id);
  if (stored) return stored;
  if (company.envKey) {
    const fromEnv = process.env[company.envKey];
    if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  }
  return null;
}

/** 'db' | 'env' | 'none' — shown in the dashboard so it's clear what's in play. */
export function keySource(company) {
  if (!company) return 'none';
  if (apiKeys.has(company.id)) return 'db';
  if (company.envKey && process.env[company.envKey]?.trim()) return 'env';
  return 'none';
}

/** Base URL for the provider: DB value wins, then its env override, then null. */
export function resolveBaseURL(company) {
  if (!company) return null;
  if (company.baseURL && company.baseURL.trim()) return company.baseURL.trim();
  if (company.baseUrlEnv) {
    const fromEnv = process.env[company.baseUrlEnv];
    if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  }
  return null;
}

/**
 * True when a company can actually be called: it needs no key (Demo), or a key
 * is available from the DB or the environment. Says nothing about `active` —
 * the chat UI shows inactive companies as absent, not as "no key".
 */
export function isCompanyAvailable(company) {
  if (!company) return false;
  if (!company.requiresKey) return true;
  return Boolean(resolveApiKey(company));
}
