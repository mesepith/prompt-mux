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
