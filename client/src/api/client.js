let sessionId = null;

export function setApiSessionId(id) {
  sessionId = id || null;
}

export function getApiSessionId() {
  return sessionId;
}

function defaultHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (sessionId) headers['X-Session-Id'] = sessionId;
  return headers;
}

async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    headers: defaultHeaders(),
    ...options,
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let code = null;
    let body = null;
    try {
      body = await res.json();
      if (body?.error) message = body.error;
      if (body?.code) code = body.code;
    } catch {
      /* keep default message */
    }
    const err = new Error(message);
    err.status = res.status;
    err.code = code;
    err.body = body; // callers can act on flags like { noAccount: true }
    throw err;
  }
  return res.json();
}

export const api = {
  health: () => request('/health'),
  models: () => request('/models'),
  listConversations: () => request('/conversations'),
  createConversation: (modelId, visionModelId) =>
    request('/conversations', {
      method: 'POST',
      body: JSON.stringify({ modelId, ...(visionModelId ? { visionModelId } : {}) }),
    }),
  getConversation: (id) => request(`/conversations/${id}`),
  updateConversation: (id, patch) =>
    request(`/conversations/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  shareConversation: (id, shared) =>
    request(`/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ shared }) }),
  forkConversation: (id) =>
    request(`/conversations/${id}/fork`, { method: 'POST' }),
  deleteConversation: (id) => request(`/conversations/${id}`, { method: 'DELETE' }),
  // Point-and-edit: replace one element of an artifact in place. `start`/`end`
  // are character offsets into the stored artifact code and `snippet` is what's
  // currently there — the server refuses the edit if they no longer match.
  editArtifact: (conversationId, body) =>
    request(`/conversations/${conversationId}/artifact-edit`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Auth
  authMe: () => request('/auth/me'),
  login: (email, password) =>
    request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, sessionId }),
    }),
  register: (email, password) =>
    request('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  verifyEmail: (email, otp) =>
    request('/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify({ email, otp, sessionId }),
    }),
  forgotPassword: (email) =>
    request('/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  resetPassword: (email, otp, password) =>
    request('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ email, otp, password, sessionId }),
    }),
  resendOtp: (email, purpose) =>
    request('/auth/resend', {
      method: 'POST',
      body: JSON.stringify({ email, purpose }),
    }),
  logout: () => request('/auth/logout', { method: 'POST' }),
};

// The admin API sits under the same private segment as the dashboard (see
// server/src/config/adminPath.js). It is learned at runtime from /api/auth/me, so
// it is never present in the shipped bundle; calling an admin endpoint before
// that resolves is a programming error and throws rather than hitting /api/null.
let adminPrefix = null;

export function setAdminApiPath(segment) {
  adminPrefix = segment || null;
}

const adminUrl = (suffix) => {
  if (!adminPrefix) {
    throw new Error('The admin API path is not known yet — sign in as an administrator first.');
  }
  return `/${adminPrefix}${suffix}`;
};

const qs = (params = {}) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
};

/**
 * Admin dashboard API, served under the private segment (`/api/<secret>/*`).
 * Every one of these is behind requireAdmin server-side — a non-admin gets 403
 * with code ADMIN_REQUIRED, which the dashboard turns into a "you don't have
 * access" screen, and a wrong segment gets a plain 404 like any unknown path.
 *
 * Provider API keys are write-only across this boundary: `setProviderKey` sends
 * one, and nothing ever returns one. The dashboard renders `hasKey`, `keySource`
 * and `apiKeyLast4` instead.
 */
export const adminApi = {
  overview: () => request(adminUrl('/overview')),

  listProviders: () => request(adminUrl('/providers')),
  createProvider: (body) =>
    request(adminUrl('/providers'), { method: 'POST', body: JSON.stringify(body) }),
  updateProvider: (slug, patch) =>
    request(adminUrl(`/providers/${encodeURIComponent(slug)}`), {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteProvider: (slug) =>
    request(adminUrl(`/providers/${encodeURIComponent(slug)}`), { method: 'DELETE' }),
  setProviderKey: (slug, apiKey) =>
    request(adminUrl(`/providers/${encodeURIComponent(slug)}/key`), {
      method: 'POST',
      body: JSON.stringify({ apiKey }),
    }),
  clearProviderKey: (slug) =>
    request(adminUrl(`/providers/${encodeURIComponent(slug)}/key`), { method: 'DELETE' }),
  testProviderKey: (slug) =>
    request(adminUrl(`/providers/${encodeURIComponent(slug)}/key/test`), { method: 'POST' }),
  discoverModels: (slug) =>
    request(adminUrl(`/providers/${encodeURIComponent(slug)}/discover-models`), { method: 'POST' }),

  listModels: (params) => request(adminUrl(`/models${qs(params)}`)),
  createModel: (body) => request(adminUrl('/models'), { method: 'POST', body: JSON.stringify(body) }),
  updateModel: (slug, patch) =>
    request(adminUrl(`/models/${encodeURIComponent(slug)}`), {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteModel: (slug, { force = false } = {}) =>
    request(adminUrl(`/models/${encodeURIComponent(slug)}${qs({ force: force ? 1 : '' })}`), {
      method: 'DELETE',
    }),
  bulkSetModelActive: (slugs, active) =>
    request(adminUrl('/models/bulk-active'), {
      method: 'POST',
      body: JSON.stringify({ slugs, active }),
    }),

  fetchPrices: (body) =>
    request(adminUrl('/prices/fetch'), { method: 'POST', body: JSON.stringify(body) }),
  // What a company-level fetch would read, and roughly what it would cost — free,
  // so the dialog can show the price of a click before it is spent.
  pricePlan: (providerSlug) => request(adminUrl(`/prices/plan${qs({ providerSlug })}`)),
  // Reads every page a company's prices are spread across (one for most vendors,
  // several for Kimi and Qwen). Returns one proposal per page.
  fetchPricesBatch: (body) =>
    request(adminUrl('/prices/fetch-batch'), { method: 'POST', body: JSON.stringify(body) }),
  listProposals: (params) => request(adminUrl(`/prices/proposals${qs(params)}`)),
  getProposal: (id) => request(adminUrl(`/prices/proposals/${encodeURIComponent(id)}`)),
  applyProposal: (id, itemIds) =>
    request(adminUrl(`/prices/proposals/${encodeURIComponent(id)}/apply`), {
      method: 'POST',
      body: JSON.stringify({ itemIds }),
    }),
  discardProposal: (id) =>
    request(adminUrl(`/prices/proposals/${encodeURIComponent(id)}/discard`), { method: 'POST' }),

  // Usage reporting: who spent what, drilled from people -> chats -> messages.
  usageUsers: (params) => request(adminUrl(`/usage/users${qs(params)}`)),
  usageUserChats: (ownerKey, params) =>
    request(adminUrl(`/usage/users/${encodeURIComponent(ownerKey)}/chats${qs(params)}`)),
  usageChat: (id) => request(adminUrl(`/usage/chats/${encodeURIComponent(id)}`)),

  getSettings: () => request(adminUrl('/settings')),
  updateSettings: (patch) =>
    request(adminUrl('/settings'), { method: 'PATCH', body: JSON.stringify(patch) }),

  reloadRegistry: () => request(adminUrl('/registry/reload'), { method: 'POST' }),
  reseedRegistry: () => request(adminUrl('/registry/reseed'), { method: 'POST' }),
  audit: (params) => request(adminUrl(`/audit${qs(params)}`)),
};

/**
 * POSTs a user message and consumes the SSE stream of the assistant reply.
 * Events: start | token | status | done | error — see server/routes/conversations.js.
 */
export async function streamMessage({ conversationId, content, modelId, images, pdfs, docs, signal, onEvent }) {
  const res = await fetch(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    credentials: 'include',
    headers: defaultHeaders(),
    body: JSON.stringify({
      content,
      modelId,
      ...(images?.length ? { images } : {}),
      ...(pdfs?.length ? { pdfs } : {}),
      ...(docs?.length ? { docs } : {}),
    }),
    signal,
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let code = null;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
      if (body?.code) code = body.code;
    } catch {
      /* keep default */
    }
    const err = new Error(message);
    err.status = res.status;
    err.code = code;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const flushLine = (line) => {
    if (!line.startsWith('data: ')) return;
    try {
      onEvent(JSON.parse(line.slice(6)));
    } catch {
      /* ignore malformed keep-alive lines */
    }
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) flushLine(line);
  }
  if (buffer) flushLine(buffer);
}
