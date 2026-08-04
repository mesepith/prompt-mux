/**
 * Admin API — everything under /api/admin.
 *
 * Mounted in index.js as `app.use('/api/admin', requireAdmin, adminRouter)`, so
 * every handler already has an authenticated administrator in `req.admin` and
 * must not add a guard of its own.
 *
 * Three rules run through the whole file:
 *  1. **A provider API key never leaves the server.** `apiKeyEncrypted` is selected
 *     only to compute `hasKey`; a response carries hasKey / keySource /
 *     apiKeyLast4 / apiKeyUpdatedAt and nothing else about the credential.
 *  2. **Every mutation calls `reloadRegistry()` before responding.** The registry
 *     is an in-process cache (config/registry.js), so a write that skips the
 *     reload keeps serving the old models until the process restarts.
 *  3. **Every mutation writes an audit entry.** These routes spend money (paid
 *     model calls on price fetches and key tests) and can switch models off for
 *     every user, so each change has to be traceable to a person.
 */
import { Router } from 'express';
import mongoose from 'mongoose';
import { Provider } from '../models/Provider.js';
import { LlmModel, MAX_PRICE_HISTORY } from '../models/LlmModel.js';
import { PriceProposal } from '../models/PriceProposal.js';
import { getAdminSettings } from '../models/AdminSetting.js';
import { User } from '../models/User.js';
import { Conversation } from '../models/Conversation.js';
import { Message } from '../models/Message.js';
import { AuditLog, audit } from '../models/AuditLog.js';
import { AdminUsage, recordAdminUsage, priceUsage } from '../models/AdminUsage.js';
import { ADAPTERS } from '../config/seedRegistry.js';
import {
  reloadRegistry,
  seedRegistry,
  registryStatus,
  listCompanies,
  listModels,
  getCompany,
  getModel,
  modelsForCompany,
  resolveApiKey,
  resolveBaseURL,
  keySource,
  isCompanyAvailable,
} from '../config/registry.js';
import {
  encryptSecret,
  keyLast4,
  encryptionAvailable,
  encryptionKeySource,
} from '../lib/secrets.js';
import { hitLimit } from '../lib/rateLimit.js';
import { adminPathSegment, updateAdminPath } from '../config/adminPath.js';
import { buildFetchPlan, estimatePlanCost } from '../lib/pricePlan.js';
import { fetchTextUrl } from '../lib/fetchUrl.js';
import { htmlToText, stripMdxArtifacts } from '../lib/htmlText.js';
import {
  PRICE_SYSTEM_PROMPT,
  buildPricePrompt,
  parsePriceReply,
  matchProposalItems,
} from '../lib/priceExtract.js';
import {
  supportsDiscovery,
  discoverProviderModels,
  diffAgainstRegistry,
} from '../lib/modelDiscovery.js';
import { streamChat } from '../providers/index.js';

const router = Router();

// --- limits and shapes ---------------------------------------------------

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,80}$/;
const CURRENCY_RE = /^[A-Za-z]{3}$/;

const MAX_NAME = 80;
const MAX_TAGLINE = 160;
const MAX_NOTES = 2000;
const MAX_URL = 500;
const MAX_API_MODEL = 200;
const MAX_API_KEY = 4000;
const MAX_PRICE = 100_000; // USD per 1M tokens — anything larger is a bad parse
const MAX_TOKENS_FIELD = 100_000_000;
const MAX_BULK_SLUGS = 500;

const USAGE_WINDOW_DAYS = 30;
const MAX_ISSUES = 20;
const MAX_USAGE_ROWS = 20;

const KEY_TEST_TIMEOUT_MS = 30_000;
// A key test is a real billed call; cap the reply so it costs a few tokens.
const KEY_TEST_MAX_TOKENS = 8;
const DISCOVERY_TIMEOUT_MS = 30_000;
const PRICE_MODEL_TIMEOUT_MS = 120_000;
const PAGE_FETCH_TIMEOUT_MS = 20_000;
const PAGE_MAX_BYTES = 4_000_000;
const RAW_EXCERPT_CHARS = 4000;
const AUTO_APPLY_CONFIDENCE = 0.7;
// Ceiling on pages one batch fetch will read, so a company with many per-model
// pages can't turn a single click into dozens of paid calls.
const MAX_BATCH_FETCH = 12;

// A price fetch makes an outbound HTTP request AND a paid model call, so it is
// throttled per administrator even though the route is already behind auth.
const PRICE_FETCH_LIMIT = { max: 10, windowMs: 10 * 60_000 };

// --- errors and validation ----------------------------------------------

function httpError(status, message, details) {
  const err = new Error(message);
  err.status = status;
  if (details) err.details = details;
  return err;
}

const badRequest = (message, details) => httpError(400, message, details);
const notFound = (message) => httpError(404, message);
const conflict = (message, details) => httpError(409, message, details);

/**
 * Wraps a handler so the field-by-field validators below can `throw badRequest()`
 * from anywhere instead of threading `res` through every check. Anything without
 * a `status` is a real bug and goes to the app error handler via next().
 */
function route(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err?.status) {
        return res.status(err.status).json({ error: err.message, ...(err.details || {}) });
      }
      next(err);
    }
  };
}

function adminAudit(req, event, metadata) {
  audit({ event, userId: req.admin?._id, email: req.admin?.email, req, metadata });
}

function pickSlug(value, field = 'slug') {
  if (typeof value !== 'string' || !value.trim()) throw badRequest(`${field} is required`);
  const slug = value.trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    throw badRequest(
      `${field} must start with a letter or digit and use only lowercase letters, digits, dot, dash or underscore (max 64 characters)`
    );
  }
  return slug;
}

/** Absent -> undefined (no change); null or '' -> null (explicit clear). */
function pickString(body, key, max, label = key) {
  if (!(key in body)) return undefined;
  const raw = body[key];
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw badRequest(`${label} must be a string`);
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw badRequest(`${label} must be at most ${max} characters`);
  return trimmed;
}

/** Present but empty is a mistake for fields the schema requires. */
function pickNonEmptyString(body, key, max) {
  const value = pickString(body, key, max);
  if (value === null) throw badRequest(`${key} cannot be empty`);
  return value;
}

function pickRequiredString(body, key, max) {
  const value = pickString(body, key, max);
  if (value === undefined || value === null) throw badRequest(`${key} is required`);
  return value;
}

function pickUrl(body, key) {
  const value = pickString(body, key, MAX_URL);
  if (value === undefined || value === null) return value;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw badRequest(`${key} must be a full URL, e.g. https://example.com/pricing`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw badRequest(`${key} must use http or https`);
  }
  return value;
}

function pickBool(body, key) {
  if (!(key in body)) return undefined;
  if (typeof body[key] !== 'boolean') throw badRequest(`${key} must be true or false`);
  return body[key];
}

function pickNumber(body, key, { min = 0, max, label = key }) {
  if (!(key in body)) return undefined;
  const raw = body[key];
  if (raw === null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) throw badRequest(`${label} must be a number`);
  // `max` is optional — a caller that clamps instead of rejecting omits it.
  // Spelled out rather than relying on `n > undefined` being false.
  if (n < min) throw badRequest(`${label} must be at least ${min}`);
  if (max !== undefined && n > max) throw badRequest(`${label} must be between ${min} and ${max}`);
  return n;
}

function pickEnvName(body, key) {
  const value = pickString(body, key, 80);
  if (value === undefined || value === null) return value;
  if (!ENV_NAME_RE.test(value)) throw badRequest(`${key} must be a valid environment variable name`);
  return value;
}

/** `{ in, out, cachedIn }`, each a number in [0, MAX_PRICE] or null. */
function pickPrice(body) {
  if (!('price' in body)) return undefined;
  const raw = body.price;
  if (raw === null) return { in: null, out: null, cachedIn: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw badRequest('price must be an object like { "in": 3, "out": 15 }');
  }
  const price = {};
  for (const key of ['in', 'out', 'cachedIn']) {
    const value = pickNumber(raw, key, { min: 0, max: MAX_PRICE, label: `price.${key}` });
    if (value !== undefined) price[key] = value;
  }
  return price;
}

/**
 * Cheap check that page text plausibly contains per-token API pricing, used to
 * avoid paying for a model call on a page that cannot possibly answer.
 *
 * Document-level, NOT line-level. A pricing table puts the unit in the header
 * row and bare amounts in the body — OpenAI's is literally
 * `| gpt-5.6-sol | $5.00 | ... | $30.00 |` — so requiring "per 1M tokens" on the
 * same line as the price rejects the best-formatted pages there are. Both signals
 * anywhere in the document is the right bar: it still rejects a page with no
 * amounts at all (Moonshot's docs render pricing in the browser) and a page that
 * never mentions tokens.
 */
function hasPricingSignal(text) {
  if (!text) return false;
  const rate =
    /(?:input|output|cached)?\s*tokens?\b|\/\s*m(?:tok|illion)?\b|per\s*(?:token|1m|1,000,000|million)/i;
  // A currency marker anywhere, not "symbol immediately followed by a digit":
  // MDX docs write amounts as `<>{"$"}3.00</>`, so the symbol and the number are
  // separated by markup. `stripMdxArtifacts` repairs most of that, but the check
  // stays loose on purpose — the cost of being wrong is one cheap call that
  // returns no rows, while being too strict silently hides a whole vendor.
  const money = /[$€£¥]|\b(?:usd|eur|gbp)\b/i;
  return money.test(text) && rate.test(text);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Cost figures are cents-of-a-cent at most; trim float noise before shipping. */
function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

// --- response shapes ----------------------------------------------------
// One helper per shape, so the field list for each lives in exactly one place.

/**
 * A provider as the dashboard sees it. Callers must have selected
 * `+apiKeyEncrypted`: it is read here only to answer "is a key stored?", and the
 * blob itself is never part of the result.
 */
function providerResponse(doc, { modelCount = 0, activeModelCount = 0 } = {}) {
  const hasKey = Boolean(doc.apiKeyEncrypted);
  const company = getCompany(doc.slug);
  return {
    _id: doc._id,
    slug: doc.slug,
    name: doc.name,
    adapter: doc.adapter,
    envKey: doc.envKey ?? null,
    baseURL: doc.baseURL ?? null,
    baseUrlEnv: doc.baseUrlEnv ?? null,
    requiresKey: doc.requiresKey !== false,
    color: doc.color || null,
    pricingUrl: doc.pricingUrl ?? null,
    docsUrl: doc.docsUrl ?? null,
    notes: doc.notes ?? null,
    active: doc.active !== false,
    sortOrder: doc.sortOrder ?? 100,
    hasKey,
    // From the registry cache, which knows about env-var keys too. A company the
    // cache hasn't caught up with yet (fallback mode) is judged from the document.
    keySource: company ? keySource(company) : hasKey ? 'db' : 'none',
    apiKeyLast4: doc.apiKeyLast4 ?? null,
    apiKeyUpdatedAt: doc.apiKeyUpdatedAt ?? null,
    keyStatus: doc.keyStatus || 'unknown',
    keyStatusMessage: doc.keyStatusMessage ?? null,
    keyCheckedAt: doc.keyCheckedAt ?? null,
    available: company ? isCompanyAvailable(company) : doc.requiresKey === false || hasKey,
    modelCount,
    activeModelCount,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function priceHistoryResponse(entry) {
  return {
    in: entry.in ?? null,
    out: entry.out ?? null,
    cachedIn: entry.cachedIn ?? null,
    source: entry.source || null,
    sourceUrl: entry.sourceUrl ?? null,
    proposalId: entry.proposalId ?? null,
    changedBy: entry.changedBy ?? null,
    note: entry.note ?? null,
    at: entry.at ?? null,
  };
}

function modelResponse(doc, { usageCount = 0 } = {}) {
  const company = getCompany(doc.company);
  const active = doc.active !== false;
  return {
    _id: doc._id,
    slug: doc.slug,
    company: doc.company,
    companyName: company?.name || doc.company,
    companyColor: company?.color || null,
    companyActive: company ? company.active : false,
    name: doc.name,
    apiModel: doc.apiModel,
    tagline: doc.tagline ?? null,
    price: {
      in: doc.price?.in ?? null,
      out: doc.price?.out ?? null,
      cachedIn: doc.price?.cachedIn ?? null,
    },
    currency: doc.currency || 'USD',
    priceSource: doc.priceSource || 'seed',
    priceUpdatedAt: doc.priceUpdatedAt ?? null,
    priceHistory: (doc.priceHistory || []).map(priceHistoryResponse),
    vision: Boolean(doc.vision),
    pdf: Boolean(doc.pdf),
    contextWindow: doc.contextWindow ?? null,
    maxOutput: doc.maxOutput ?? null,
    pricingUrl: doc.pricingUrl ?? null,
    notes: doc.notes ?? null,
    active,
    sortOrder: doc.sortOrder ?? 100,
    // "Can a user actually pick this right now?" — needs the model on, its
    // company on, and a key available.
    available: Boolean(active && company?.active && isCompanyAvailable(company)),
    usageCount,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function proposalItemResponse(item) {
  return {
    _id: item._id,
    modelSlug: item.modelSlug ?? null,
    matchedBy: item.matchedBy ?? null,
    label: item.label ?? null,
    apiModel: item.apiModel ?? null,
    unit: item.unit ?? null,
    currency: item.currency || 'USD',
    inPrice: item.inPrice ?? null,
    outPrice: item.outPrice ?? null,
    cachedInPrice: item.cachedInPrice ?? null,
    currentIn: item.currentIn ?? null,
    currentOut: item.currentOut ?? null,
    confidence: item.confidence ?? null,
    evidence: item.evidence ?? null,
    applied: Boolean(item.applied),
    appliedAt: item.appliedAt ?? null,
  };
}

function proposalResponse(doc) {
  return {
    _id: doc._id,
    scope: doc.scope,
    providerSlug: doc.providerSlug,
    modelSlug: doc.modelSlug ?? null,
    sourceUrl: doc.sourceUrl,
    adminModelId: doc.adminModelId ?? null,
    pageChars: doc.pageChars ?? null,
    usedChars: doc.usedChars ?? null,
    truncated: Boolean(doc.truncated),
    status: doc.status,
    items: (doc.items || []).map(proposalItemResponse),
    warnings: doc.warnings || [],
    error: doc.error ?? null,
    rawExcerpt: doc.rawExcerpt ?? null,
    usage: doc.usage ?? null,
    // What this fetch cost, priced against the admin model that ran it. Surfaced
    // per-proposal as well as in the Overview total, so the cost is visible at the
    // moment of the action rather than only in a monthly aggregate.
    costUsd: priceUsage(doc.adminModelId, doc.usage).costUsd,
    createdBy: doc.createdBy ?? null,
    appliedBy: doc.appliedBy ?? null,
    appliedAt: doc.appliedAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** List rows don't need every extracted item — the detail endpoint has those. */
function proposalSummary(doc) {
  const items = doc.items || [];
  return {
    _id: doc._id,
    scope: doc.scope,
    providerSlug: doc.providerSlug,
    modelSlug: doc.modelSlug ?? null,
    sourceUrl: doc.sourceUrl,
    adminModelId: doc.adminModelId ?? null,
    status: doc.status,
    itemCount: items.length,
    appliedCount: items.filter((i) => i.applied).length,
    error: doc.error ?? null,
    totalTokens: doc.usage?.totalTokens ?? null,
    costUsd: priceUsage(doc.adminModelId, doc.usage).costUsd,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// --- shared lookups -----------------------------------------------------

async function findProviderDoc(slug) {
  const doc = await Provider.findOne({ slug }).select('+apiKeyEncrypted');
  if (!doc) throw notFound(`No company with slug "${slug}"`);
  return doc;
}

async function providerWithCounts(doc) {
  const [modelCount, activeModelCount] = await Promise.all([
    LlmModel.countDocuments({ company: doc.slug }),
    LlmModel.countDocuments({ company: doc.slug, active: true }),
  ]);
  return providerResponse(doc, { modelCount, activeModelCount });
}

async function modelWithUsage(doc) {
  const usageCount = await Message.countDocuments({ modelId: doc.slug });
  return modelResponse(doc, { usageCount });
}

/** The registry cache is authoritative, with the collection as the backstop. */
async function assertCompanyExists(slug) {
  if (getCompany(slug)) return;
  if (await Provider.exists({ slug })) return;
  throw badRequest(`Unknown company "${slug}" — create the company first`);
}

async function findProposalDoc(id) {
  if (!mongoose.isValidObjectId(id)) throw notFound('Proposal not found');
  const doc = await PriceProposal.findById(id);
  if (!doc) throw notFound('Proposal not found');
  return doc;
}

/**
 * Stores a key on a provider document: encrypted, never in plaintext, and with
 * the previous test result cleared because it described a different credential.
 * Shared by provider creation, PATCH and the dedicated key endpoint so the
 * encryption check exists in exactly one place.
 */
function applyKeyToDoc(doc, apiKey, adminId) {
  if (!encryptionAvailable()) {
    throw httpError(
      503,
      'Cannot store a provider key: set ENCRYPTION_KEY (32 bytes) or a JWT_SECRET of at least 16 characters in server/.env, then restart the server. Until then, keep using the provider\'s env var.'
    );
  }
  doc.apiKeyEncrypted = encryptSecret(apiKey);
  doc.apiKeyLast4 = keyLast4(apiKey);
  doc.apiKeyUpdatedAt = new Date();
  doc.apiKeyUpdatedBy = adminId;
  doc.keyStatus = 'unknown';
  doc.keyStatusMessage = null;
  doc.keyCheckedAt = null;
}

function pickApiKey(body) {
  if (!('apiKey' in body) || body.apiKey === null || body.apiKey === '') return undefined;
  if (typeof body.apiKey !== 'string') throw badRequest('apiKey must be a string');
  const key = body.apiKey.trim();
  if (!key) return undefined;
  if (key.length > MAX_API_KEY) throw badRequest('apiKey is too long to be a real credential');
  return key;
}

// --- field whitelists ---------------------------------------------------
// req.body is never spread into an update: each field is validated by name, and
// anything else the caller sent is dropped.

function providerFields(body, { isCreate }) {
  const fields = {};
  const set = (key, value) => {
    if (value !== undefined) fields[key] = value;
  };

  set('name', isCreate ? pickRequiredString(body, 'name', MAX_NAME) : pickNonEmptyString(body, 'name', MAX_NAME));

  if ('adapter' in body) {
    const adapter = pickNonEmptyString(body, 'adapter', 40).toLowerCase();
    if (!ADAPTERS.includes(adapter)) {
      throw badRequest(`adapter must be one of: ${ADAPTERS.join(', ')}`);
    }
    fields.adapter = adapter;
  } else if (isCreate) {
    // Almost every vendor ships an OpenAI-compatible endpoint, so that's the
    // useful default for a company added from the dashboard.
    fields.adapter = 'openai';
  }

  set('envKey', pickEnvName(body, 'envKey'));
  set('baseUrlEnv', pickEnvName(body, 'baseUrlEnv'));
  set('baseURL', pickUrl(body, 'baseURL'));
  set('pricingUrl', pickUrl(body, 'pricingUrl'));
  set('docsUrl', pickUrl(body, 'docsUrl'));
  set('notes', pickString(body, 'notes', MAX_NOTES));
  set('requiresKey', pickBool(body, 'requiresKey'));
  set('active', pickBool(body, 'active'));
  set('sortOrder', pickNumber(body, 'sortOrder', { min: -100_000, max: 1_000_000 }));

  if ('color' in body) {
    const color = pickString(body, 'color', 7);
    if (color !== null && !COLOR_RE.test(color)) {
      throw badRequest('color must be a hex colour like #10a37f');
    }
    fields.color = color === null ? '#71717a' : color.toLowerCase();
  }

  return fields;
}

function modelFields(body, { isCreate }) {
  const fields = {};
  const set = (key, value) => {
    if (value !== undefined) fields[key] = value;
  };

  set('name', isCreate ? pickRequiredString(body, 'name', MAX_NAME) : pickNonEmptyString(body, 'name', MAX_NAME));
  set(
    'apiModel',
    isCreate
      ? pickRequiredString(body, 'apiModel', MAX_API_MODEL)
      : pickNonEmptyString(body, 'apiModel', MAX_API_MODEL)
  );
  if ('company' in body) fields.company = pickSlug(body.company, 'company');
  else if (isCreate) fields.company = pickSlug(undefined, 'company');

  set('tagline', pickString(body, 'tagline', MAX_TAGLINE));
  set('notes', pickString(body, 'notes', MAX_NOTES));
  set('pricingUrl', pickUrl(body, 'pricingUrl'));
  set('vision', pickBool(body, 'vision'));
  set('pdf', pickBool(body, 'pdf'));
  set('active', pickBool(body, 'active'));
  set('contextWindow', pickNumber(body, 'contextWindow', { min: 0, max: MAX_TOKENS_FIELD }));
  set('maxOutput', pickNumber(body, 'maxOutput', { min: 0, max: MAX_TOKENS_FIELD }));
  set('sortOrder', pickNumber(body, 'sortOrder', { min: -100_000, max: 1_000_000 }));
  set('price', pickPrice(body));

  if ('currency' in body) {
    const currency = pickString(body, 'currency', 3);
    if (currency !== null && !CURRENCY_RE.test(currency)) {
      throw badRequest('currency must be a 3-letter code like USD');
    }
    fields.currency = currency === null ? 'USD' : currency.toUpperCase();
  }

  return fields;
}

// --- price writes -------------------------------------------------------

function currentPrice(doc) {
  return {
    in: doc.price?.in ?? null,
    out: doc.price?.out ?? null,
    cachedIn: doc.price?.cachedIn ?? null,
  };
}

/** Newest last, oldest dropped — this array is read on every boot. */
function pushPriceHistory(doc, previous, meta) {
  doc.priceHistory.push({ ...previous, ...meta, at: new Date() });
  const overflow = doc.priceHistory.length - MAX_PRICE_HISTORY;
  if (overflow > 0) doc.priceHistory.splice(0, overflow);
}

/**
 * A price typed in by an administrator. Recorded in priceHistory like a fetched
 * one, so "why did this model's cost change?" always has an answer.
 */
function applyManualPrice(doc, price, adminId) {
  const previous = currentPrice(doc);
  const next = {
    in: price.in !== undefined ? price.in : previous.in,
    out: price.out !== undefined ? price.out : previous.out,
    cachedIn: price.cachedIn !== undefined ? price.cachedIn : previous.cachedIn,
  };
  if (next.in === previous.in && next.out === previous.out && next.cachedIn === previous.cachedIn) {
    return false;
  }
  pushPriceHistory(doc, previous, {
    source: doc.priceSource || 'manual',
    changedBy: adminId,
    note: 'replaced by a manual edit',
  });
  doc.price = next;
  doc.priceSource = 'manual';
  doc.priceUpdatedAt = new Date();
  return true;
}

function itemHasPrice(item) {
  return [item.inPrice, item.outPrice, item.cachedInPrice].some(
    (value) => typeof value === 'number' && value >= 0 && value <= MAX_PRICE
  );
}

function usablePrice(value) {
  return typeof value === 'number' && value >= 0 && value <= MAX_PRICE ? value : null;
}

/**
 * Writes selected proposal rows into the registry. Used by the apply endpoint
 * and by the auto-apply path of a fetch when approval is switched off, so both
 * behave identically.
 *
 * `itemIds` is 'all' or an array of item _ids. A row is skipped unless it still
 * matches a model and carries at least one plausible price — the extractor's
 * output is a suggestion, not a source of truth.
 */
/**
 * Applies selected proposal rows to the registry.
 *
 * `onDuplicate` decides what happens when two selected rows target the same
 * model — which pricing pages cause constantly, by listing a standard rate and a
 * cache-hit rate for one model. Left alone, the last row silently wins and
 * DeepSeek's $0.435 input price becomes its $0.0036 cache rate, understating
 * every cost in the app a hundredfold.
 *   'reject' — 409, so the admin picks the row they meant (interactive apply).
 *   'skip'   — leave those models untouched and warn (auto-apply, where there is
 *              no human to ask; guessing is exactly what must not happen).
 */
async function applyProposalItems({ proposal, itemIds, admin, req, onDuplicate = 'reject' }) {
  const wanted = itemIds === 'all' ? null : new Set(itemIds.map(String));
  const changes = [];

  const isSelected = (item) =>
    !item.applied &&
    (!wanted || wanted.has(String(item._id))) &&
    item.modelSlug &&
    itemHasPrice(item);

  const perModel = new Map();
  for (const item of proposal.items.filter(isSelected)) {
    perModel.set(item.modelSlug, (perModel.get(item.modelSlug) || 0) + 1);
  }
  const duplicated = [...perModel.entries()].filter(([, n]) => n > 1).map(([slug]) => slug);

  if (duplicated.length && onDuplicate === 'reject') {
    throw httpError(
      409,
      `More than one selected row writes to ${duplicated.join(', ')}. Pricing pages list a standard ` +
        'and a cache-hit rate for the same model — pick the single row you mean.',
      { code: 'DUPLICATE_MODEL_ROWS', slugs: duplicated }
    );
  }
  const skipModels = new Set(onDuplicate === 'skip' ? duplicated : []);
  if (skipModels.size) {
    proposal.warnings = [
      ...(proposal.warnings || []),
      `Auto-apply skipped ${[...skipModels].join(', ')}: the page priced each of them more than once, so no row could be chosen without a human.`,
    ].slice(0, 20);
  }

  for (const item of proposal.items) {
    if (item.applied) continue;
    if (wanted && !wanted.has(String(item._id))) continue;
    if (!item.modelSlug || !itemHasPrice(item)) continue;
    if (skipModels.has(item.modelSlug)) continue;

    const doc = await LlmModel.findOne({ slug: item.modelSlug });
    if (!doc) continue; // the model was deleted after the fetch

    const previous = currentPrice(doc);
    pushPriceHistory(doc, previous, {
      source: doc.priceSource || 'manual',
      sourceUrl: proposal.sourceUrl,
      proposalId: proposal._id,
      changedBy: admin._id,
      note: item.label || null,
    });

    const next = { ...previous };
    for (const [target, incoming] of [
      ['in', item.inPrice],
      ['out', item.outPrice],
      ['cachedIn', item.cachedInPrice],
    ]) {
      const value = usablePrice(incoming);
      if (value !== null) next[target] = value; // null in the proposal = "page didn't say"
    }
    doc.price = next;
    doc.priceSource = 'fetched';
    doc.priceUpdatedAt = new Date();
    await doc.save();

    item.applied = true;
    item.appliedAt = new Date();
    changes.push({ modelSlug: item.modelSlug, from: previous, to: next });
  }

  const applicable = proposal.items.filter((item) => item.modelSlug && itemHasPrice(item));
  if (changes.length) {
    proposal.status = applicable.every((item) => item.applied) ? 'applied' : 'partially-applied';
    proposal.appliedBy = admin._id;
    proposal.appliedAt = new Date();
  }
  await proposal.save();

  if (changes.length) {
    await reloadRegistry();
    adminAudit(req, 'admin_price_applied', {
      proposalId: String(proposal._id),
      providerSlug: proposal.providerSlug,
      sourceUrl: proposal.sourceUrl,
      slugs: changes.map((c) => c.modelSlug),
      changes,
    });
  }

  return { proposal, applied: changes.length };
}

/**
 * The model that reads pricing pages: an explicit request wins, then Settings,
 * then ADMIN_LLM_MODEL, then the first usable non-demo model. Demo is refused
 * outright — it is an offline stub and cannot read a web page.
 */
function resolveAdminModel(requested, settings) {
  const configured = requested || settings.adminModelId || process.env.ADMIN_LLM_MODEL || null;
  if (configured) {
    const model = getModel(configured);
    if (!model) {
      throw badRequest(
        `The admin model "${configured}" is not in the registry — pick one in Settings.`
      );
    }
    if (model.company === 'demo') {
      throw badRequest(
        `${model.name} is an offline demo model and cannot read a pricing page. Choose a real model in Settings.`
      );
    }
    if (!model.active) {
      throw badRequest(`${model.name} is switched off — pick a different admin model in Settings.`);
    }
    const company = getCompany(model.company);
    if (!isCompanyAvailable(company)) {
      throw badRequest(
        `${model.name} can't be used: ${company?.name || model.company} has no API key. Add one, or pick a different admin model in Settings.`
      );
    }
    return model;
  }

  const fallback = listModels().find(
    (model) => model.company !== 'demo' && isCompanyAvailable(getCompany(model.company))
  );
  if (!fallback) {
    throw badRequest(
      'No admin model is configured and no company has a usable API key. Configure one in Settings first.'
    );
  }
  return fallback;
}

// --- GET /overview ------------------------------------------------------

router.get(
  '/overview',
  route(async (req, res) => {
    const since = new Date(Date.now() - USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const [
      providers,
      activeProviders,
      models,
      activeModels,
      pricedModels,
      users,
      admins,
      conversations,
      messages,
      usageRows,
      recent,
      settings,
      adminUsageRows,
    ] = await Promise.all([
      Provider.countDocuments({}),
      Provider.countDocuments({ active: true }),
      LlmModel.countDocuments({}),
      LlmModel.countDocuments({ active: true }),
      LlmModel.countDocuments({ 'price.in': { $ne: null }, 'price.out': { $ne: null } }),
      User.countDocuments({}),
      User.countDocuments({ role: 'admin' }),
      Conversation.countDocuments({}),
      Message.countDocuments({}),
      Message.aggregate([
        { $match: { createdAt: { $gte: since }, modelId: { $exists: true, $ne: null } } },
        {
          $group: {
            _id: '$modelId',
            messages: { $sum: 1 },
            inputTokens: { $sum: { $ifNull: ['$usage.inputTokens', 0] } },
            outputTokens: { $sum: { $ifNull: ['$usage.outputTokens', 0] } },
          },
        },
      ]),
      PriceProposal.find({}).sort({ createdAt: -1 }).limit(5).lean(),
      getAdminSettings(),
      // Spend by the dashboard itself — price fetches and key tests. Kept separate
      // from chat spend above because it answers a different question: "what is
      // this admin panel costing me?"
      AdminUsage.aggregate([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: { kind: '$kind', modelId: '$modelId' },
            calls: { $sum: 1 },
            inputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
            outputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } },
            costUsd: { $sum: { $ifNull: ['$costUsd', 0] } },
            unpriced: { $sum: { $cond: [{ $eq: ['$priced', false] }, 1, 0] } },
            failures: { $sum: { $cond: [{ $eq: ['$ok', false] }, 1, 0] } },
          },
        },
      ]),
    ]);

    const byModel = usageRows.map((row) => {
      const model = getModel(row._id);
      const company = model ? getCompany(model.company) : null;
      const priced = Boolean(model?.price);
      const costUsd = priced
        ? (model.price.in * row.inputTokens + model.price.out * row.outputTokens) / 1e6
        : 0;
      return {
        modelId: row._id,
        name: model?.name || row._id,
        companyName: company?.name || model?.company || 'Unknown',
        messages: row.messages,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        costUsd: round6(costUsd),
        priced,
      };
    });
    byModel.sort((a, b) => b.costUsd - a.costUsd || b.messages - a.messages);

    const configuredAdminModelId =
      settings.adminModelId || process.env.ADMIN_LLM_MODEL || null;
    const adminModelEntry = configuredAdminModelId ? getModel(configuredAdminModelId) : null;
    const adminCompany = adminModelEntry ? getCompany(adminModelEntry.company) : null;

    const registry = registryStatus();
    const encryption = { available: encryptionAvailable(), source: encryptionKeySource() };

    // Issues are built from real state, not from a checklist. Warnings are sorted
    // ahead of info notes before the cap, so a hundred unpriced models can't
    // push "this company has no key" off the list.
    const issues = [];
    if (!encryption.available) {
      issues.push({
        kind: 'no-encryption-key',
        severity: 'warn',
        message:
          'No ENCRYPTION_KEY (or usable JWT_SECRET) is set, so provider keys cannot be stored in the database — only env-var keys work.',
        target: null,
      });
    } else if (encryption.source === 'JWT_SECRET') {
      issues.push({
        kind: 'weak-encryption',
        severity: 'warn',
        message:
          'Provider keys are encrypted with a key derived from JWT_SECRET. Set ENCRYPTION_KEY in server/.env — rotating JWT_SECRET would otherwise make stored keys unreadable.',
        target: null,
      });
    }
    if (registry.usingFallback) {
      issues.push({
        kind: 'registry-fallback',
        severity: 'warn',
        message:
          'The registry is serving the built-in defaults — nothing was loaded from MongoDB. Reseed or reload the registry.',
        target: null,
      });
    }
    for (const company of listCompanies({ includeInactive: true })) {
      if (company.active && company.requiresKey && !isCompanyAvailable(company)) {
        issues.push({
          kind: 'no-key',
          severity: 'warn',
          message: `${company.name} is active but has no API key, so its models fail on the first message.`,
          target: company.id,
        });
      }
    }
    if (!adminModelEntry) {
      issues.push({
        kind: 'no-admin-model',
        severity: 'info',
        message: configuredAdminModelId
          ? `The configured admin model "${configuredAdminModelId}" is not in the registry — pick another in Settings.`
          : 'No admin model is set, so a price fetch has to guess which model reads the page. Pick one in Settings.',
        target: configuredAdminModelId,
      });
    }
    for (const model of listModels({ includeInactive: true })) {
      if (!model.active) continue;
      const company = getCompany(model.company);
      if (company && !company.active) {
        issues.push({
          kind: 'company-inactive',
          severity: 'info',
          message: `${model.name} is active but ${company.name} is switched off, so nobody can use it.`,
          target: model.id,
        });
      }
      if (!model.price) {
        issues.push({
          kind: 'no-price',
          severity: 'info',
          message: `${model.name} has no price — its messages show tokens with no cost.`,
          target: model.id,
        });
      }
    }
    issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'warn' ? -1 : 1));

    res.json({
      registry,
      encryption,
      adminModel: adminModelEntry
        ? {
            id: adminModelEntry.id,
            name: adminModelEntry.name,
            company: adminModelEntry.company,
            companyName: adminCompany?.name || adminModelEntry.company,
          }
        : null,
      counts: {
        providers,
        activeProviders,
        models,
        activeModels,
        pricedModels,
        users,
        admins,
        conversations,
        messages,
      },
      issues: issues.slice(0, MAX_ISSUES),
      usage: {
        days: USAGE_WINDOW_DAYS,
        messages: usageRows.reduce((sum, row) => sum + row.messages, 0),
        estimatedCostUsd: round6(byModel.reduce((sum, row) => sum + row.costUsd, 0)),
        byModel: byModel.slice(0, MAX_USAGE_ROWS),
      },
      adminUsage: {
        days: USAGE_WINDOW_DAYS,
        calls: adminUsageRows.reduce((sum, row) => sum + row.calls, 0),
        estimatedCostUsd: round6(adminUsageRows.reduce((sum, row) => sum + (row.costUsd || 0), 0)),
        inputTokens: adminUsageRows.reduce((sum, row) => sum + row.inputTokens, 0),
        outputTokens: adminUsageRows.reduce((sum, row) => sum + row.outputTokens, 0),
        // A row whose model has no price contributes 0 to the total, so say how
        // many there were rather than letting the figure quietly read as complete.
        unpricedCalls: adminUsageRows.reduce((sum, row) => sum + row.unpriced, 0),
        rows: adminUsageRows
          .map((row) => {
            const model = getModel(row._id.modelId);
            return {
              kind: row._id.kind,
              modelId: row._id.modelId,
              modelName: model?.name || row._id.modelId || '(unknown model)',
              companyName: model ? getCompany(model.company)?.name || model.company : null,
              calls: row.calls,
              failures: row.failures,
              inputTokens: row.inputTokens,
              outputTokens: row.outputTokens,
              costUsd: round6(row.costUsd || 0),
              unpriced: row.unpriced,
            };
          })
          .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls),
      },
      recentProposals: recent.map((doc) => ({
        _id: doc._id,
        providerSlug: doc.providerSlug,
        modelSlug: doc.modelSlug ?? null,
        status: doc.status,
        itemCount: (doc.items || []).length,
        appliedCount: (doc.items || []).filter((item) => item.applied).length,
        createdAt: doc.createdAt,
      })),
    });
  })
);

// --- companies (providers) ---------------------------------------------

router.get(
  '/providers',
  route(async (req, res) => {
    const [docs, counts] = await Promise.all([
      Provider.find({}).select('+apiKeyEncrypted').sort({ sortOrder: 1, name: 1 }).lean(),
      LlmModel.aggregate([
        {
          $group: {
            _id: '$company',
            total: { $sum: 1 },
            active: { $sum: { $cond: [{ $eq: ['$active', true] }, 1, 0] } },
          },
        },
      ]),
    ]);
    const byCompany = new Map(counts.map((row) => [row._id, row]));
    res.json({
      providers: docs.map((doc) =>
        providerResponse(doc, {
          modelCount: byCompany.get(doc.slug)?.total || 0,
          activeModelCount: byCompany.get(doc.slug)?.active || 0,
        })
      ),
    });
  })
);

router.post(
  '/providers',
  route(async (req, res) => {
    const body = req.body || {};
    const slug = pickSlug(body.slug, 'slug');
    if (await Provider.exists({ slug })) {
      throw conflict(`A company with slug "${slug}" already exists`);
    }
    const fields = providerFields(body, { isCreate: true });
    const apiKey = pickApiKey(body);

    const doc = new Provider({ slug, ...fields });
    if (apiKey) applyKeyToDoc(doc, apiKey, req.admin._id);
    try {
      await doc.save();
    } catch (err) {
      if (err?.code === 11000) throw conflict(`A company with slug "${slug}" already exists`);
      throw err;
    }

    await reloadRegistry();
    adminAudit(req, 'admin_provider_created', {
      slug,
      name: doc.name,
      adapter: doc.adapter,
      keyStored: Boolean(apiKey),
      ...(apiKey ? { last4: doc.apiKeyLast4 } : {}),
    });
    if (apiKey) adminAudit(req, 'admin_key_set', { slug, last4: doc.apiKeyLast4, via: 'create' });

    res.status(201).json({ provider: await providerWithCounts(doc) });
  })
);

router.patch(
  '/providers/:slug',
  route(async (req, res) => {
    const body = req.body || {};
    const slug = pickSlug(req.params.slug, 'slug');
    // Conversations and messages reference the slug, so it can never move.
    if (body.slug !== undefined && pickSlug(body.slug, 'slug') !== slug) {
      throw badRequest(
        'A company slug cannot be changed — models and conversations reference it. Create a new company instead.'
      );
    }

    const doc = await findProviderDoc(slug);
    const fields = providerFields(body, { isCreate: false });
    const apiKey = pickApiKey(body);
    Object.assign(doc, fields);
    if (apiKey) applyKeyToDoc(doc, apiKey, req.admin._id);
    await doc.save();

    await reloadRegistry();
    adminAudit(req, 'admin_provider_updated', { slug, fields: Object.keys(fields) });
    if (apiKey) adminAudit(req, 'admin_key_set', { slug, last4: doc.apiKeyLast4, via: 'patch' });

    res.json({ provider: await providerWithCounts(doc) });
  })
);

router.delete(
  '/providers/:slug',
  route(async (req, res) => {
    const slug = pickSlug(req.params.slug, 'slug');
    const doc = await Provider.findOne({ slug });
    if (!doc) throw notFound(`No company with slug "${slug}"`);

    const modelCount = await LlmModel.countDocuments({ company: slug });
    if (modelCount > 0) {
      throw conflict(
        `${doc.name} still has ${modelCount} model(s). Delete or move them first.`,
        { modelCount, code: 'COMPANY_HAS_MODELS' }
      );
    }

    await Provider.deleteOne({ _id: doc._id });
    await reloadRegistry();
    adminAudit(req, 'admin_provider_deleted', { slug, name: doc.name });
    res.json({ ok: true });
  })
);

// --- provider keys ------------------------------------------------------

router.post(
  '/providers/:slug/key',
  route(async (req, res) => {
    const slug = pickSlug(req.params.slug, 'slug');
    const apiKey = pickApiKey(req.body || {});
    if (!apiKey) throw badRequest('apiKey is required');

    const doc = await findProviderDoc(slug);
    applyKeyToDoc(doc, apiKey, req.admin._id);
    await doc.save();

    await reloadRegistry();
    adminAudit(req, 'admin_key_set', { slug, last4: doc.apiKeyLast4 });
    res.json({ provider: await providerWithCounts(doc) });
  })
);

router.delete(
  '/providers/:slug/key',
  route(async (req, res) => {
    const slug = pickSlug(req.params.slug, 'slug');
    const doc = await findProviderDoc(slug);
    const had = Boolean(doc.apiKeyEncrypted);

    doc.apiKeyEncrypted = null;
    doc.apiKeyLast4 = null;
    doc.apiKeyUpdatedAt = null;
    doc.apiKeyUpdatedBy = null;
    doc.keyStatus = 'unknown';
    doc.keyStatusMessage = null;
    doc.keyCheckedAt = null;
    await doc.save();

    await reloadRegistry();
    adminAudit(req, 'admin_key_cleared', { slug, hadStoredKey: had });
    res.json({ provider: await providerWithCounts(doc) });
  })
);

/**
 * POST /providers/:slug/key/test — one real (cheap) call through the adapter.
 *
 * A rejected key is a *result*, not a server error: it answers 200 with
 * { ok: false, message } so the dashboard can render the provider's own
 * complaint, and the outcome is stored so the table doesn't have to spend money
 * on every page load.
 */
router.post(
  '/providers/:slug/key/test',
  route(async (req, res) => {
    const slug = pickSlug(req.params.slug, 'slug');
    const doc = await findProviderDoc(slug);

    const candidates = modelsForCompany(slug);
    const model = candidates.find((m) => m.active) || candidates[0];
    if (!model) {
      throw badRequest(
        `${doc.name} has no models yet — add one before testing the key, since the test is a real chat call.`
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), KEY_TEST_TIMEOUT_MS);
    let ok = false;
    let message;
    let usage = null;
    try {
      const result = await streamChat({
        model,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        system: null,
        signal: controller.signal,
        onToken: () => {},
        // This is a real, billed call — there is no free "is this key valid"
        // endpoint that works across every vendor. Cap the reply so the test costs
        // a handful of tokens rather than a full-length answer.
        maxTokens: KEY_TEST_MAX_TOKENS,
      });
      usage = result?.usage || null;
      ok = true;
      message = `Verified with ${model.name}`;
    } catch (err) {
      message = (err?.message || 'The provider rejected the request').slice(0, 300);
    } finally {
      clearTimeout(timer);
    }

    doc.keyStatus = ok ? 'ok' : 'failed';
    doc.keyStatusMessage = message;
    doc.keyCheckedAt = new Date();
    await doc.save();

    // Billed either way: a rejected request can still have been charged for its
    // input tokens, and a test that spends money with no line item is exactly what
    // the usage ledger exists to prevent.
    const cost = priceUsage(model.id, usage);
    recordAdminUsage({
      kind: 'key_test',
      modelId: model.id,
      usage,
      targetProviderSlug: slug,
      ok,
      error: ok ? null : message,
      admin: req.admin,
    });

    adminAudit(req, 'admin_key_tested', {
      slug,
      modelId: model.id,
      ok,
      keySource: keySource(getCompany(slug)),
      tokens: usage?.totalTokens ?? 0,
      costUsd: cost.costUsd,
      ...(ok ? {} : { message }),
    });
    res.json({
      ok,
      modelId: model.id,
      message,
      usage,
      costUsd: cost.costUsd,
      provider: await providerWithCounts(doc),
    });
  })
);

/**
 * POST /providers/:slug/discover-models — asks the provider what it offers and
 * diffs that against the registry. Reports only: nothing is created here, because
 * a model needs a price, a tagline and capability flags that a /models list
 * can't tell us.
 */
router.post(
  '/providers/:slug/discover-models',
  route(async (req, res) => {
    const slug = pickSlug(req.params.slug, 'slug');
    const company = getCompany(slug);
    if (!company) throw notFound(`No company with slug "${slug}"`);
    if (!supportsDiscovery(company)) {
      throw badRequest(
        `Model discovery isn't available for ${company.name} (adapter "${company.adapter}").`
      );
    }
    const apiKey = resolveApiKey(company);
    if (company.requiresKey && !apiKey) {
      throw badRequest(`${company.name} has no API key, so its model list can't be read.`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
    let discovered;
    try {
      discovered = await discoverProviderModels({
        company,
        apiKey,
        baseURL: resolveBaseURL(company),
        signal: controller.signal,
      });
    } catch (err) {
      throw httpError(502, err?.message || 'The provider would not return its model list');
    } finally {
      clearTimeout(timer);
    }

    const ids = Array.isArray(discovered) ? discovered : discovered?.ids || [];
    const diff = diffAgainstRegistry(ids, modelsForCompany(slug)) || {};
    adminAudit(req, 'admin_models_discovered', {
      slug,
      returned: ids.length,
      newFromProvider: (diff.newFromProvider || []).length,
      missingFromProvider: (diff.missingFromProvider || []).length,
    });
    res.json({
      ids,
      known: diff.known || [],
      missingFromProvider: diff.missingFromProvider || [],
      newFromProvider: diff.newFromProvider || [],
    });
  })
);

// --- models -------------------------------------------------------------

router.get(
  '/models',
  route(async (req, res) => {
    const filter = {};
    const company = typeof req.query.company === 'string' ? req.query.company.trim() : '';
    if (company && company !== 'all') filter.company = company.toLowerCase();
    const includeInactive = req.query.includeInactive === '1' || req.query.includeInactive === 'true';
    if (!includeInactive) filter.active = true;
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      filter.$or = [{ slug: rx }, { name: rx }, { apiModel: rx }, { tagline: rx }];
    }

    // One aggregation for every model's usage — a per-row countDocuments would be
    // dozens of queries on a page that loads on every dashboard visit.
    const [docs, usageRows] = await Promise.all([
      LlmModel.find(filter).sort({ company: 1, sortOrder: 1, name: 1 }).lean(),
      Message.aggregate([
        { $match: { modelId: { $exists: true, $ne: null } } },
        { $group: { _id: '$modelId', count: { $sum: 1 } } },
      ]),
    ]);
    const usageBySlug = new Map(usageRows.map((row) => [row._id, row.count]));

    res.json({
      models: docs.map((doc) => modelResponse(doc, { usageCount: usageBySlug.get(doc.slug) || 0 })),
    });
  })
);

router.post(
  '/models',
  route(async (req, res) => {
    const body = req.body || {};
    const slug = pickSlug(body.slug, 'slug');
    if (await LlmModel.exists({ slug })) {
      throw conflict(`A model with slug "${slug}" already exists`);
    }
    const fields = modelFields(body, { isCreate: true });
    await assertCompanyExists(fields.company);

    const { price, ...rest } = fields;
    const doc = new LlmModel({ slug, ...rest });
    if (price) {
      doc.price = {
        in: price.in ?? null,
        out: price.out ?? null,
        cachedIn: price.cachedIn ?? null,
      };
      // A price an admin typed is 'manual', never 'seed' — priceSource is what
      // tells the dashboard whether a number came from a human or a page.
      if (doc.price.in !== null || doc.price.out !== null) {
        doc.priceSource = 'manual';
        doc.priceUpdatedAt = new Date();
      }
    }
    try {
      await doc.save();
    } catch (err) {
      if (err?.code === 11000) throw conflict(`A model with slug "${slug}" already exists`);
      throw err;
    }

    await reloadRegistry();
    adminAudit(req, 'admin_model_created', {
      slug,
      company: doc.company,
      name: doc.name,
      apiModel: doc.apiModel,
    });
    res.status(201).json({ model: await modelWithUsage(doc) });
  })
);

router.patch(
  '/models/:slug',
  route(async (req, res) => {
    const body = req.body || {};
    const slug = pickSlug(req.params.slug, 'slug');
    // Conversation.modelId / Message.modelId store this value.
    if (body.slug !== undefined && pickSlug(body.slug, 'slug') !== slug) {
      throw badRequest(
        'A model slug cannot be changed — existing conversations reference it. Create a new model instead.'
      );
    }

    const doc = await LlmModel.findOne({ slug });
    if (!doc) throw notFound(`No model with slug "${slug}"`);

    const fields = modelFields(body, { isCreate: false });
    const { price, ...rest } = fields;
    if (rest.company && rest.company !== doc.company) await assertCompanyExists(rest.company);
    Object.assign(doc, rest);
    if (price) applyManualPrice(doc, price, req.admin._id);
    await doc.save();

    await reloadRegistry();
    adminAudit(req, 'admin_model_updated', {
      slug,
      company: doc.company,
      fields: Object.keys(fields),
    });
    res.json({ model: await modelWithUsage(doc) });
  })
);

/**
 * POST /models/bulk-active — the "switch off everything from this company" case.
 * Declared before DELETE/:slug is irrelevant (different verb) but it must come
 * before nothing else: Express matches on method + path.
 */
router.post(
  '/models/bulk-active',
  route(async (req, res) => {
    const body = req.body || {};
    if (!Array.isArray(body.slugs) || !body.slugs.length) {
      throw badRequest('slugs must be a non-empty array of model slugs');
    }
    if (body.slugs.length > MAX_BULK_SLUGS) {
      throw badRequest(`slugs must contain at most ${MAX_BULK_SLUGS} entries`);
    }
    const active = pickBool(body, 'active');
    if (active === undefined) throw badRequest('active must be true or false');
    const slugs = body.slugs.map((slug) => pickSlug(slug, 'slugs[]'));

    const result = await LlmModel.updateMany({ slug: { $in: slugs } }, { $set: { active } });
    await reloadRegistry();
    adminAudit(req, 'admin_model_updated', {
      bulk: true,
      active,
      slugs,
      updated: result.modifiedCount ?? 0,
    });
    res.json({ updated: result.modifiedCount ?? 0 });
  })
);

router.delete(
  '/models/:slug',
  route(async (req, res) => {
    const slug = pickSlug(req.params.slug, 'slug');
    const doc = await LlmModel.findOne({ slug });
    if (!doc) throw notFound(`No model with slug "${slug}"`);

    const usageCount = await Message.countDocuments({ modelId: slug });
    const force = req.query.force === '1' || req.query.force === 'true';
    if (usageCount > 0 && !force) {
      throw conflict(
        `${doc.name} is referenced by ${usageCount} message(s). Deactivate it instead, or delete with force=1 — the history keeps the id either way.`,
        { usageCount, code: 'MODEL_IN_USE' }
      );
    }

    // Deleting a model never touches conversations or messages: their modelId is
    // history, and the chat UI already handles an id the registry no longer knows.
    await LlmModel.deleteOne({ _id: doc._id });
    await reloadRegistry();
    adminAudit(req, 'admin_model_deleted', {
      slug,
      company: doc.company,
      name: doc.name,
      usageCount,
      forced: force,
    });
    res.json({ ok: true });
  })
);

// --- prices -------------------------------------------------------------

/**
 * POST /prices/fetch — read a pricing page with the admin model and store the
 * result as a proposal.
 *
 * Nothing is written to the registry here unless approval is switched off, and a
 * failure is still persisted (status 'failed', answered with 200) so the
 * dashboard can show what went wrong instead of a bare toast.
 */
/**
 * Runs one page → proposal cycle: fetch, reduce to text, extract with the admin
 * model, persist. Shared by the single-page route and the multi-page batch so the
 * two can never drift apart on validation, billing or auto-apply.
 *
 * Always resolves — a failure becomes a persisted `failed` proposal rather than a
 * throw, because the dashboard has to be able to show what went wrong. The caller
 * owns rate limiting; by the time this is called the slot is already reserved.
 */
async function runPriceFetch({ company, model, sourceUrl, settings, adminModel, admin, req }) {
  const providerSlug = company.id;
  const base = {
    scope: model ? 'model' : 'provider',
    providerSlug,
    modelSlug: model?.id || null,
    sourceUrl,
    adminModelId: adminModel.id,
    createdBy: admin._id,
  };

  // The prompt only describes what we want priced; matching accepts every model of
  // the company so a row for a switched-off model can still be applied.
  // priceExtract works in its own vocabulary (`slug`, `currentIn`, `currentOut`);
  // registry objects use `id` and a nested `price`. Translate once, here, rather
  // than letting either side guess about the other.
  const forExtractor = (m) => ({
    slug: m.id,
    name: m.name,
    apiModel: m.apiModel,
    currentIn: m.price?.in ?? null,
    currentOut: m.price?.out ?? null,
  });
  const promptModels = (
    model ? [model] : modelsForCompany(providerSlug).filter((m) => m.active)
  ).map(forExtractor);
  const matchModels = (model ? [model] : modelsForCompany(providerSlug)).map(forExtractor);

  let page = null;
  let reply = '';
  let usage = null;
  try {
    const fetched = await fetchTextUrl(sourceUrl, {
      timeoutMs: PAGE_FETCH_TIMEOUT_MS,
      maxBytes: PAGE_MAX_BYTES,
    });
    const raw = typeof fetched === 'string' ? fetched : fetched?.text ?? fetched?.body ?? '';
    // Several vendors serve a markdown twin of every docs page (append `.md`),
    // which is a far cleaner and cheaper source than the rendered HTML — the
    // pricing table arrives as a pipe table with no navigation chrome. Running
    // the HTML stripper over it would only risk mangling it, so pass it through.
    const isHtml = /^\s*<(?:!doctype|html|head|body)/i.test(raw.slice(0, 200));
    if (isHtml) {
      page = htmlToText(raw, { maxChars: settings.fetchMaxChars });
    } else {
      const cleaned = stripMdxArtifacts(raw);
      page = {
        text: cleaned.slice(0, settings.fetchMaxChars),
        chars: cleaned.length,
        truncated: cleaned.length > settings.fetchMaxChars,
      };
    }

    // Bail before spending tokens when the page plainly carries no per-token
    // pricing. Some vendors render pricing entirely in the browser, so a
    // server-side fetch sees only marketing copy and subscription tiers — and
    // asking a model to read that either wastes a call or, worse, tempts it into
    // reporting "$14.99/mo" as a token price.
    if (!hasPricingSignal(page.text)) {
      throw new Error(
        'The fetched page contains no per-token pricing text. It is most likely rendered by JavaScript, ' +
          'which a server-side fetch cannot see. Point this at a documentation page that ships the ' +
          'pricing table in HTML, or enter the prices by hand on the Models tab.'
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PRICE_MODEL_TIMEOUT_MS);
    try {
      const result = await streamChat({
        model: adminModel,
        messages: [
          {
            role: 'user',
            content: buildPricePrompt({
              pageText: page.text,
              sourceUrl,
              companyName: company.name,
              models: promptModels,
            }),
          },
        ],
        system: PRICE_SYSTEM_PROMPT,
        signal: controller.signal,
        onToken: () => {},
      });
      reply = result.content || '';
      usage = result.usage || null;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const failed = await PriceProposal.create({
      ...base,
      status: 'failed',
      error: (err?.message || 'The price fetch failed').slice(0, 500),
      pageChars: page?.chars ?? null,
      usedChars: page?.text?.length ?? null,
      truncated: Boolean(page?.truncated),
      usage,
    });
    // Only bill a ledger row when the model was actually reached. A URL blocked
    // by the SSRF guard, or a page with no pricing on it, never reaches the
    // provider — recording those as spend would inflate the figure with calls
    // that cost nothing.
    const failedCost = priceUsage(adminModel.id, usage);
    if (usage) {
      recordAdminUsage({
        kind: 'price_fetch',
        modelId: adminModel.id,
        usage,
        targetProviderSlug: providerSlug,
        targetModelSlug: base.modelSlug,
        sourceUrl,
        proposalId: failed._id,
        ok: false,
        error: failed.error,
        admin,
      });
    }
    adminAudit(req, 'admin_price_fetched', {
      providerSlug,
      modelSlug: base.modelSlug,
      sourceUrl,
      adminModelId: adminModel.id,
      status: 'failed',
      error: failed.error,
      tokens: usage?.totalTokens ?? 0,
      costUsd: failedCost.costUsd,
    });
    return { proposal: failed, costUsd: failedCost.costUsd, tokens: usage?.totalTokens ?? 0 };
  }

  const parsed = parsePriceReply(reply) || {};
  const rawItems = Array.isArray(parsed) ? parsed : parsed.items || [];
  const matched = matchProposalItems({ items: rawItems, models: matchModels }) || {};
  const items = Array.isArray(matched) ? matched : matched.items || [];
  const warnings = [...(parsed.warnings || []), ...(matched.warnings || [])].slice(0, 20);

  let proposal = await PriceProposal.create({
    ...base,
    status: 'ready',
    // The registry snapshot has to live in the proposal, or a later edit would
    // silently rewrite the "before" side of the diff.
    items: items.map((item) => {
      const target = item.modelSlug ? getModel(item.modelSlug) : null;
      return {
        ...item,
        currentIn: item.currentIn ?? target?.price?.in ?? null,
        currentOut: item.currentOut ?? target?.price?.out ?? null,
      };
    }),
    warnings,
    pageChars: page.chars ?? null,
    usedChars: page.text?.length ?? null,
    truncated: Boolean(page.truncated),
    rawExcerpt: reply.slice(0, RAW_EXCERPT_CHARS),
    usage,
  });

  const fetchCost = priceUsage(adminModel.id, usage);
  recordAdminUsage({
    kind: 'price_fetch',
    modelId: adminModel.id,
    usage,
    targetProviderSlug: providerSlug,
    targetModelSlug: base.modelSlug,
    sourceUrl,
    proposalId: proposal._id,
    ok: true,
    admin,
  });

  adminAudit(req, 'admin_price_fetched', {
    providerSlug,
    modelSlug: base.modelSlug,
    sourceUrl,
    adminModelId: adminModel.id,
    status: 'ready',
    itemCount: proposal.items.length,
    warnings: warnings.length,
    // Recorded on the audit row too, so the Activity feed shows what each
    // fetch cost without a join against the usage ledger.
    tokens: usage?.totalTokens ?? 0,
    costUsd: fetchCost.costUsd,
  });

  if (!settings.requireApproval) {
    const confident = proposal.items
      .filter(
        (item) =>
          item.modelSlug && typeof item.confidence === 'number' && item.confidence >= AUTO_APPLY_CONFIDENCE
      )
      .map((item) => String(item._id));
    if (confident.length) {
      const applied = await applyProposalItems({
        proposal,
        itemIds: confident,
        admin,
        req,
        // Nobody is watching this path, so an ambiguous model is left for a
        // human rather than resolved by guesswork.
        onDuplicate: 'skip',
      });
      proposal = applied.proposal;
    }
  }

  return { proposal, costUsd: fetchCost.costUsd, tokens: usage?.totalTokens ?? 0 };
}

/**
 * Resolves the company (and optional model) a price request is about.
 * Throws the same 404/400s both price routes need.
 */
function resolvePriceTarget(body) {
  const providerSlug = pickSlug(body.providerSlug, 'providerSlug');
  const company = getCompany(providerSlug);
  if (!company) throw notFound(`No company with slug "${providerSlug}"`);

  let model = null;
  if (body.modelSlug) {
    const modelSlug = pickSlug(body.modelSlug, 'modelSlug');
    model = getModel(modelSlug);
    if (!model) throw notFound(`No model with slug "${modelSlug}"`);
    if (model.company !== providerSlug) {
      throw badRequest(`${model.name} does not belong to ${company.name}`);
    }
  }
  return { company, model };
}

/** 429 unless `cost` fetch slots are available for this admin. */
function reserveFetchSlots(req, cost) {
  const limit = hitLimit(`admin-price-fetch:${req.admin._id}`, PRICE_FETCH_LIMIT, cost);
  if (limit.ok) return null;
  return {
    error:
      cost > 1
        ? `That would be ${cost} price fetches and your remaining allowance is smaller. Try again in ${Math.ceil(limit.retryAfterMs / 60000)} minute(s), or fetch models one at a time.`
        : `Too many price fetches. Try again in ${Math.ceil(limit.retryAfterMs / 60000)} minute(s).`,
    retryAfterMs: limit.retryAfterMs,
  };
}

/**
 * GET /prices/plan?providerSlug=X — what a company-level fetch would read, and
 * roughly what it would cost, WITHOUT spending anything.
 *
 * This exists so the dialog can say "3 pages, about $0.002" before the click.
 * Companies whose vendor publishes one price table need a single call; Kimi and
 * Qwen publish per model, so those need several.
 */
router.get(
  '/prices/plan',
  route(async (req, res) => {
    const { company } = resolvePriceTarget({ providerSlug: req.query.providerSlug });
    const settings = await getAdminSettings();
    let adminModel = null;
    let adminModelError = null;
    try {
      adminModel = resolveAdminModel(null, settings);
    } catch (err) {
      adminModelError = err.message;
    }

    const plan = buildFetchPlan(company, modelsForCompany(company.id), { maxCalls: MAX_BATCH_FETCH });
    const estimate = estimatePlanCost(plan, adminModel);

    res.json({
      providerSlug: company.id,
      companyName: company.name,
      mode: plan.mode,
      calls: plan.calls,
      uncovered: plan.uncovered,
      dropped: plan.dropped,
      maxCalls: MAX_BATCH_FETCH,
      adminModel: adminModel
        ? { id: adminModel.id, name: adminModel.name, company: adminModel.company }
        : null,
      adminModelError,
      estimate,
    });
  })
);

/**
 * POST /prices/fetch — read ONE pricing page and store the result as a proposal.
 *
 * Nothing is written to the registry unless approval is switched off, and a
 * failure is still persisted (status 'failed', answered with 200) so the
 * dashboard can show what went wrong instead of a bare toast.
 */
router.post(
  '/prices/fetch',
  route(async (req, res) => {
    const body = req.body || {};
    const { company, model } = resolvePriceTarget(body);

    const override = pickUrl(body, 'url');
    const sourceUrl = override || (model ? model.pricingUrl || company.pricingUrl : company.pricingUrl);
    if (!sourceUrl) {
      throw badRequest(
        model
          ? `Neither ${model.name} nor ${company.name} has a pricing URL. Add one, or pass a url with this request.`
          : `${company.name} has no pricing URL of its own. Its models may have their own pages — use the batch fetch, or pass a url with this request.`
      );
    }

    const settings = await getAdminSettings();
    const adminModel = resolveAdminModel(pickString(body, 'adminModelId', 120) || null, settings);

    // Charged work starts here, so the throttle sits after validation: a rejected
    // request must not eat an administrator's budget of fetches.
    const denied = reserveFetchSlots(req, 1);
    if (denied) return res.status(429).json(denied);

    const { proposal } = await runPriceFetch({
      company,
      model,
      sourceUrl,
      settings,
      adminModel,
      admin: req.admin,
      req,
    });
    res.json({ proposal: proposalResponse(proposal) });
  })
);

/**
 * POST /prices/fetch-batch — read every page a company's prices are spread over.
 *
 * For a vendor with one price table this is the same single call as above. For
 * Kimi or Qwen it is one call per page, run **sequentially**: a provider being
 * hammered with parallel requests is a worse neighbour, and sequential keeps the
 * per-page cost legible in the ledger. The whole allowance is reserved up front so
 * a batch cannot die half-finished.
 */
router.post(
  '/prices/fetch-batch',
  route(async (req, res) => {
    const body = req.body || {};
    const { company } = resolvePriceTarget(body);
    const settings = await getAdminSettings();
    const adminModel = resolveAdminModel(pickString(body, 'adminModelId', 120) || null, settings);

    const plan = buildFetchPlan(company, modelsForCompany(company.id), { maxCalls: MAX_BATCH_FETCH });
    if (plan.mode === 'none') {
      throw badRequest(
        `Neither ${company.name} nor any of its models has a pricing URL. Add one to the company, or to each model that prices separately.`
      );
    }

    // An explicit subset is allowed, but only from the plan — this endpoint must
    // not become a way to point the fetcher at arbitrary URLs in bulk.
    let calls = plan.calls;
    if (Array.isArray(body.urls) && body.urls.length) {
      const wanted = new Set(body.urls.map((u) => String(u).trim()));
      calls = plan.calls.filter((c) => wanted.has(c.url));
      if (!calls.length) {
        throw badRequest('None of the supplied urls are part of this company\'s pricing plan.');
      }
    }

    const denied = reserveFetchSlots(req, calls.length);
    if (denied) return res.status(429).json(denied);

    const results = [];
    for (const call of calls) {
      // One model per page means the proposal can be scoped to it, which gives a
      // tighter prompt; a shared page stays company-scoped so every row matches.
      const only =
        call.modelSlugs.length === 1 ? getModel(call.modelSlugs[0]) : null;
      const result = await runPriceFetch({
        company,
        model: only,
        sourceUrl: call.url,
        settings,
        adminModel,
        admin: req.admin,
        req,
      });
      results.push(result);
    }

    const proposals = results.map((r) => proposalResponse(r.proposal));
    res.json({
      proposals,
      calls: calls.length,
      skipped: plan.dropped,
      uncovered: plan.uncovered,
      totalTokens: results.reduce((sum, r) => sum + (r.tokens || 0), 0),
      totalCostUsd: round6(results.reduce((sum, r) => sum + (r.costUsd || 0), 0)),
      failed: proposals.filter((p) => p.status === 'failed').length,
      itemCount: proposals.reduce((sum, p) => sum + (p.items?.length || 0), 0),
    });
  })
);

router.get(
  '/prices/proposals',
  route(async (req, res) => {
    const filter = {};
    if (typeof req.query.providerSlug === 'string' && req.query.providerSlug.trim()) {
      filter.providerSlug = pickSlug(req.query.providerSlug, 'providerSlug');
    }
    const limit = clamp(Number(req.query.limit) || 25, 1, 100);
    const docs = await PriceProposal.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ proposals: docs.map(proposalSummary) });
  })
);

router.get(
  '/prices/proposals/:id',
  route(async (req, res) => {
    const doc = await findProposalDoc(req.params.id);
    res.json({ proposal: proposalResponse(doc) });
  })
);

router.post(
  '/prices/proposals/:id/apply',
  route(async (req, res) => {
    const proposal = await findProposalDoc(req.params.id);
    if (proposal.status === 'failed') throw badRequest('That fetch failed — there is nothing to apply.');
    if (proposal.status === 'discarded') throw badRequest('That proposal was discarded.');

    const { itemIds } = req.body || {};
    let selection;
    if (itemIds === 'all') {
      selection = 'all';
    } else if (Array.isArray(itemIds)) {
      if (!itemIds.length) throw badRequest('Select at least one row to apply.');
      if (itemIds.length > MAX_BULK_SLUGS) throw badRequest('Too many rows in one apply.');
      for (const id of itemIds) {
        if (typeof id !== 'string' || !mongoose.isValidObjectId(id)) {
          throw badRequest('itemIds must be proposal item ids');
        }
      }
      selection = itemIds;
    } else {
      // Deliberately not defaulting to "all": prices drive every cost figure in
      // the UI, so a mass write has to be asked for explicitly.
      throw badRequest("itemIds is required — pass 'all' or an array of item ids.");
    }

    const result = await applyProposalItems({ proposal, itemIds: selection, admin: req.admin, req });
    res.json({ proposal: proposalResponse(result.proposal), applied: result.applied });
  })
);

router.post(
  '/prices/proposals/:id/discard',
  route(async (req, res) => {
    const proposal = await findProposalDoc(req.params.id);
    if (proposal.status === 'applied') {
      throw badRequest('That proposal was already applied.');
    }
    proposal.status = 'discarded';
    await proposal.save();
    adminAudit(req, 'admin_price_discarded', {
      proposalId: String(proposal._id),
      providerSlug: proposal.providerSlug,
      itemCount: proposal.items.length,
    });
    res.json({ proposal: proposalResponse(proposal) });
  })
);

// --- settings -----------------------------------------------------------

function settingsResponse(doc) {
  return {
    adminModelId: doc.adminModelId ?? null,
    fetchMaxChars: doc.fetchMaxChars,
    requireApproval: doc.requireApproval !== false,
    // The dashboard's own URL. Safe to return here — this endpoint is already
    // behind requireAdmin AND behind the secret segment, so anyone reading this
    // response necessarily knows the path already.
    adminPath: adminPathSegment(),
    adminPathPinned: Boolean(process.env.ADMIN_PATH && process.env.ADMIN_PATH.trim()),
    updatedAt: doc.updatedAt,
  };
}

router.get(
  '/settings',
  route(async (req, res) => {
    const settings = await getAdminSettings();
    // Only models that could actually read a pricing page: active, keyed, and not
    // the offline demo company.
    const candidates = listModels()
      .filter((model) => model.company !== 'demo')
      .map((model) => {
        const company = getCompany(model.company);
        return {
          id: model.id,
          name: model.name,
          company: model.company,
          companyName: company?.name || model.company,
          available: isCompanyAvailable(company),
        };
      })
      .filter((candidate) => candidate.available);
    res.json({ settings: settingsResponse(settings), candidates });
  })
);

router.patch(
  '/settings',
  route(async (req, res) => {
    const body = req.body || {};
    const settings = await getAdminSettings();
    const changed = [];

    if ('adminModelId' in body) {
      const value = pickString(body, 'adminModelId', 120);
      if (value === null) {
        settings.adminModelId = null;
      } else {
        const model = getModel(value);
        if (!model) throw badRequest(`"${value}" is not a model in the registry`);
        if (model.company === 'demo') {
          throw badRequest(
            `${model.name} is an offline demo model and cannot read a pricing page — pick a real model.`
          );
        }
        settings.adminModelId = model.id;
      }
      changed.push('adminModelId');
    }

    if ('fetchMaxChars' in body) {
      // Clamped, never rejected: the schema's bounds are the contract, and a
      // field that clamps 500_000 but 400s on 99_999_999 is the kind of
      // inconsistency that reads as a bug from the dashboard. A non-number is
      // still an error — that's a malformed request, not an out-of-range one.
      const value = pickNumber(body, 'fetchMaxChars', { min: 0 });
      settings.fetchMaxChars = value === null ? 60_000 : clamp(Math.round(value), 2_000, 400_000);
      changed.push('fetchMaxChars');
    }

    const requireApproval = pickBool(body, 'requireApproval');
    if (requireApproval !== undefined) {
      settings.requireApproval = requireApproval;
      changed.push('requireApproval');
    }

    // Changing this moves the dashboard's URL, so it is applied through
    // config/adminPath.js (which validates the segment, refuses when ADMIN_PATH
    // pins it, and updates the in-process value so routing follows immediately).
    // Saved separately from `settings` below because that helper owns the write.
    let movedTo = null;
    if ('adminPath' in body) {
      movedTo = await updateAdminPath(body.adminPath);
      changed.push('adminPath');
    }

    settings.updatedBy = req.admin._id;
    await settings.save();
    adminAudit(req, 'admin_settings_updated', {
      fields: changed,
      adminModelId: settings.adminModelId,
      fetchMaxChars: settings.fetchMaxChars,
      requireApproval: settings.requireApproval,
      // Recorded so a lost dashboard URL can be recovered from the audit trail.
      ...(movedTo ? { adminPath: movedTo } : {}),
    });
    res.json({ settings: settingsResponse(settings) });
  })
);

// --- registry maintenance ----------------------------------------------

router.post(
  '/registry/reload',
  route(async (req, res) => {
    await reloadRegistry();
    res.json({ ok: true, registry: registryStatus() });
  })
);

/** Restores seed entries that were deleted. Existing rows are never overwritten. */
router.post(
  '/registry/reseed',
  route(async (req, res) => {
    const created = await seedRegistry();
    await reloadRegistry();
    adminAudit(req, 'admin_registry_reseeded', created);
    res.json({ ok: true, created });
  })
);

// --- audit --------------------------------------------------------------

const ADMIN_EVENTS = AuditLog.schema.path('event').enumValues.filter((event) =>
  event.startsWith('admin_')
);

router.get(
  '/audit',
  route(async (req, res) => {
    const limit = clamp(Number(req.query.limit) || 50, 1, 200);
    const filter = { event: { $in: ADMIN_EVENTS } };
    if (typeof req.query.event === 'string' && req.query.event.trim()) {
      const event = req.query.event.trim();
      if (!AuditLog.schema.path('event').enumValues.includes(event)) {
        throw badRequest(`Unknown audit event "${event}"`);
      }
      filter.event = event;
    }
    const entries = await AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('_id event email ip metadata createdAt')
      .lean();
    res.json({ entries });
  })
);

export default router;
