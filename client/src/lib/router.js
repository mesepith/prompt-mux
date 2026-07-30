// Tiny history-based router — no router library, only two URL shapes:
//   /         -> a new, not-yet-saved chat
//   /c/<id>   -> an existing conversation (bookmarkable + shareable)
//
// Every chat gets its own link the moment it is created (see the store's
// sendMessage). The SPA fallback in server/src/index.js serves index.html for
// these paths in production; Vite's dev server does the same.

const CHAT_PREFIX = '/c/';
const OBJECT_ID = /^[a-f\d]{24}$/i;

export function conversationPath(id) {
  return `${CHAT_PREFIX}${id}`;
}

/** Absolute link to a chat — what the Share button copies. */
export function shareUrl(id) {
  return `${window.location.origin}${conversationPath(id)}`;
}

/** Conversation id in the current URL, or null when we're on a new chat. */
export function currentRouteId() {
  const { pathname } = window.location;
  if (!pathname.startsWith(CHAT_PREFIX)) return null;
  const id = pathname.slice(CHAT_PREFIX.length).split('/')[0];
  return OBJECT_ID.test(id) ? id : null;
}

/** Point the address bar at a conversation (or at `/` when id is null). */
export function navigateTo(id, { replace = false } = {}) {
  const url = id ? conversationPath(id) : '/';
  const current = `${window.location.pathname}${window.location.search}`;
  if (current === url) return;
  const state = { conversationId: id || null };
  if (replace) window.history.replaceState(state, '', url);
  else window.history.pushState(state, '', url);
}

/** Subscribe to back/forward navigation. Returns an unsubscribe function. */
export function onRouteChange(handler) {
  const listener = () => handler(currentRouteId());
  window.addEventListener('popstate', listener);
  return () => window.removeEventListener('popstate', listener);
}
