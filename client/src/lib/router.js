// Tiny history-based router — no router library. Three URL shapes:
//   /                  -> a new, not-yet-saved chat
//   /c/<id>            -> an existing conversation (bookmarkable + shareable)
//   /<secret>[/tab]    -> the admin dashboard
//
// The dashboard's segment is deliberately NOT in this file. It is a private,
// unguessable value the server generates (or ADMIN_PATH pins), and the client
// only learns it from GET /api/auth/me when the signed-in user is an admin — so
// it never ships in the JS bundle, and a non-admin has no way to discover it.
// Until setAdminPath() is called, an admin URL simply resolves to the chat app.
//
// Every chat gets its own link the moment it is created (see the store's
// sendMessage). The SPA fallback in server/src/index.js serves index.html for
// all of these paths in production; Vite's dev server does the same.

const CHAT_PREFIX = '/c/';
const OBJECT_ID = /^[a-f\d]{24}$/i;

export const ADMIN_TABS = ['overview', 'providers', 'models', 'pricing', 'settings', 'activity'];

let adminSegment = null;

/** Called once auth resolves. Pass null to forget it (logout, non-admin). */
export function setAdminPath(segment) {
  adminSegment = segment || null;
}

export function getAdminPath() {
  return adminSegment;
}

/** True when the current URL is the dashboard — only knowable once we have the segment. */
export function onAdminUrl() {
  if (!adminSegment) return false;
  const base = `/${adminSegment}`;
  const { pathname } = window.location;
  return pathname === base || pathname.startsWith(`${base}/`);
}

export function conversationPath(id) {
  return `${CHAT_PREFIX}${id}`;
}

/** Absolute link to a chat — what the Share button copies. */
export function shareUrl(id) {
  return `${window.location.origin}${conversationPath(id)}`;
}

/** URL for an admin tab, or null when the segment isn't known yet. */
export function adminPath(tab) {
  if (!adminSegment) return null;
  const base = `/${adminSegment}`;
  return tab && tab !== 'overview' ? `${base}/${tab}` : base;
}

/** Conversation id in the current URL, or null when we're not on a chat link. */
export function currentRouteId() {
  const { pathname } = window.location;
  if (!pathname.startsWith(CHAT_PREFIX)) return null;
  const id = pathname.slice(CHAT_PREFIX.length).split('/')[0];
  return OBJECT_ID.test(id) ? id : null;
}

/**
 * The current route as a tagged object. App.jsx switches on `kind` to decide
 * between the chat app and the dashboard; unknown /admin/<junk> falls back to
 * the overview tab rather than a blank screen.
 */
export function currentRoute() {
  if (onAdminUrl()) {
    const rest = window.location.pathname
      .slice(adminSegment.length + 1)
      .replace(/^\//, '')
      .split('/')[0];
    return { kind: 'admin', tab: ADMIN_TABS.includes(rest) ? rest : 'overview', id: null };
  }
  const id = currentRouteId();
  return id ? { kind: 'chat', id, tab: null } : { kind: 'new', id: null, tab: null };
}

/** Point the address bar at a conversation (or at `/` when id is null). */
export function navigateTo(id, { replace = false } = {}) {
  pushUrl(id ? conversationPath(id) : '/', { replace, state: { conversationId: id || null } });
}

/** Point the address bar at an admin tab. No-op until the segment is known. */
export function navigateToAdmin(tab = 'overview', { replace = false } = {}) {
  const url = adminPath(tab);
  if (!url) return;
  pushUrl(url, { replace, state: { adminTab: tab } });
}

function pushUrl(url, { replace, state }) {
  const current = `${window.location.pathname}${window.location.search}`;
  if (current === url) return;
  if (replace) window.history.replaceState(state, '', url);
  else window.history.pushState(state, '', url);
  // pushState/replaceState don't fire popstate, so in-app navigation between the
  // chat and the dashboard has to announce itself or App.jsx never re-renders.
  //
  // Deferred to a microtask on purpose: the store calls navigateTo() *before*
  // committing `currentId` (see selectConversation), so a synchronous event would
  // reach handleRouteChange while the store still held the previous id and
  // re-enter the very navigation that fired it. By the time a microtask runs, the
  // store has been updated and its "same id" guard does its job.
  queueMicrotask(() => window.dispatchEvent(new Event('pm:route')));
}

/**
 * Subscribe to route changes — browser Back/Forward *and* in-app navigation.
 * The handler receives the object from currentRoute(). Returns an unsubscribe fn.
 */
export function onRouteChange(handler) {
  const listener = () => handler(currentRoute());
  window.addEventListener('popstate', listener);
  window.addEventListener('pm:route', listener);
  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener('pm:route', listener);
  };
}
