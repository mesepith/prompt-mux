async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      /* keep default message */
    }
    throw new Error(message);
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
  deleteConversation: (id) => request(`/conversations/${id}`, { method: 'DELETE' }),
  // Point-and-edit: replace one element of an artifact in place. `start`/`end`
  // are character offsets into the stored artifact code and `snippet` is what's
  // currently there — the server refuses the edit if they no longer match.
  editArtifact: (conversationId, body) =>
    request(`/conversations/${conversationId}/artifact-edit`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

/**
 * POSTs a user message and consumes the SSE stream of the assistant reply.
 * Events: start | token | status | done | error — see server/routes/conversations.js.
 */
export async function streamMessage({ conversationId, content, modelId, images, pdfs, docs, signal, onEvent }) {
  const res = await fetch(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      /* keep default */
    }
    throw new Error(message);
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
