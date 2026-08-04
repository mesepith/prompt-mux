import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { SEED_MODELS } from '../config/seedRegistry.js';

/**
 * Model discovery — ask a provider's own API which model ids it actually serves.
 *
 * This is the free, authoritative half of registry maintenance: no LLM call, and
 * the provider is the last word on which ids exist, so this is what catches
 * renamed and retired models. It returns *only* ids — no provider exposes prices
 * over its API, which is why pricing is a separate (paid, LLM-driven) tool.
 */

// Deliberately not seedRegistry's ADAPTERS: they happen to be the same list
// today, but an adapter with no listing endpoint must not be advertised here.
const DISCOVERY_ADAPTERS = new Set(['openai', 'anthropic', 'google', 'demo']);

// The Google SDK has no listing call and ignores base URL overrides (same as the
// chat adapter), so discovery talks to the REST endpoint directly.
const GOOGLE_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

export function supportsDiscovery(company) {
  return !!company && DISCOVERY_ADAPTERS.has(company.adapter);
}

/** Case-insensitive de-dupe (first spelling wins) plus a stable sort. */
function normalizeIds(raw) {
  const seen = new Map();
  for (const value of raw || []) {
    const id = typeof value === 'string' ? value.trim() : '';
    if (id && !seen.has(id.toLowerCase())) seen.set(id.toLowerCase(), id);
  }
  return [...seen.values()].sort();
}

function isAbort(err) {
  return (
    err?.name === 'AbortError' || err?.name === 'TimeoutError' || err?.name === 'APIUserAbortError'
  );
}

async function collectSdkIds(page) {
  const inline = Array.isArray(page) ? page : Array.isArray(page?.data) ? page.data : null;
  if (page && typeof page[Symbol.asyncIterator] === 'function') {
    const ids = [];
    try {
      for await (const item of page) if (typeof item?.id === 'string') ids.push(item.id);
      return ids;
    } catch (err) {
      // OpenAI-compatible vendors often answer without the pagination envelope,
      // which makes the SDK's auto-paginating iterator throw. The body it did
      // return is still on the page object — prefer it over failing the run.
      if (!inline || isAbort(err)) throw err;
    }
  }
  return (inline || []).filter((item) => typeof item?.id === 'string').map((item) => item.id);
}

async function listGoogleModels({ apiKey, signal }) {
  const ids = [];
  let pageToken = '';
  // pageSize caps at 1000; the loop bound is only a runaway guard.
  for (let page = 0; page < 10; page += 1) {
    const url = new URL(GOOGLE_MODELS_URL);
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    // The key travels in a header, never the query string: URLs end up in access
    // logs, proxy logs and error reports.
    const res = await fetch(url, { headers: { 'x-goog-api-key': apiKey || '' }, signal });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(`${res.status} ${body?.error?.message || res.statusText || 'request failed'}`);
    }
    for (const model of body?.models || []) {
      if (typeof model?.name === 'string') ids.push(model.name.replace(/^models\//, ''));
    }
    pageToken = body?.nextPageToken || '';
    if (!pageToken) break;
  }
  return ids;
}

function describeError(err) {
  const status = err?.status ?? err?.response?.status ?? null;
  const raw =
    err?.error?.error?.message || err?.error?.message || err?.message || (err ? String(err) : '');
  const message = String(raw).trim() || 'unknown error';
  // SDK error messages already open with the status code; don't print it twice.
  return status && !message.startsWith(String(status)) ? `${status} ${message}` : message;
}

/**
 * @param {object} args.company  a cached registry company
 * @param {string} args.apiKey   resolved key (registry.resolveApiKey)
 * @param {string} [args.baseURL] resolved base URL (registry.resolveBaseURL)
 * @returns {Promise<{ ids: string[] }>} sorted, de-duplicated provider model ids
 */
export async function discoverProviderModels({
  company,
  apiKey,
  baseURL,
  signal,
  timeoutMs = 20000,
}) {
  if (!company) throw new Error('discoverProviderModels requires a company');
  const label = company.name || company.id;
  if (!supportsDiscovery(company)) {
    throw new Error(`${label} cannot be discovered: adapter "${company.adapter}" lists no models.`);
  }

  // Demo has no API to ask, so the seed *is* its served list. That keeps the
  // whole discovery flow (and the admin UI around it) exercisable with no keys.
  if (company.adapter === 'demo') {
    const ids = SEED_MODELS.filter((m) => m.company === 'demo').map((m) => m.apiModel);
    return { ids: normalizeIds(ids) };
  }

  // A hung provider must not hold an admin request open; the caller's own signal
  // still wins so a closed connection cancels the listing.
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  try {
    let ids;
    if (company.adapter === 'openai') {
      const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
      ids = await collectSdkIds(await client.models.list({ signal: combined }));
    } else if (company.adapter === 'anthropic') {
      const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
      // Default page size is 20 — ask for everything in one round trip.
      ids = await collectSdkIds(await client.models.list({ limit: 1000 }, { signal: combined }));
    } else {
      ids = await listGoogleModels({ apiKey, signal: combined });
    }
    return { ids: normalizeIds(ids) };
  } catch (err) {
    if (timeout.aborted) throw new Error(`${label} model listing timed out after ${timeoutMs}ms`);
    if (signal?.aborted) throw err; // caller cancelled: let the abort travel untouched
    throw new Error(`${label} model listing failed: ${describeError(err)}`);
  }
}

/**
 * Compare a provider's served ids against what the registry claims for it.
 * Pure — no registry or network access, so it is the part worth unit testing.
 *
 * @param {string[]} ids  from discoverProviderModels
 * @param {Array<{ id: string, apiModel: string, name: string }>} registryModels
 *        the registry's models for that one company
 */
export function diffAgainstRegistry(ids, registryModels) {
  // lowercase id -> the spelling the provider used, which is what we show.
  // First spelling wins, matching normalizeIds.
  const served = new Map();
  for (const value of ids || []) {
    const id = typeof value === 'string' ? value.trim() : '';
    if (id && !served.has(id.toLowerCase())) served.set(id.toLowerCase(), id);
  }

  const known = [];
  const missingFromProvider = [];
  const registered = new Set();
  for (const model of registryModels || []) {
    if (!model) continue;
    const apiModel = typeof model.apiModel === 'string' ? model.apiModel.trim().toLowerCase() : '';
    if (apiModel) registered.add(apiModel);
    const entry = { slug: model.id, apiModel: model.apiModel, name: model.name };
    // No apiModel means nothing can serve it, so it belongs with the retired ones.
    if (apiModel && served.has(apiModel)) known.push(entry);
    else missingFromProvider.push(entry);
  }

  const newFromProvider = [...served]
    .filter(([key]) => !registered.has(key))
    .map(([, id]) => id)
    .sort();

  return { known, missingFromProvider, newFromProvider };
}
