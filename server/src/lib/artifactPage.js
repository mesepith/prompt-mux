/**
 * The standalone artifact page served at `/a/<publicId>`.
 *
 * This is the one place where model-written HTML is handed to a browser as a
 * top-level document on this app's own origin, so it repeats — and must keep
 * repeating — both halves of the in-app preview's defence:
 *
 *  1. the artifact only ever runs inside `<iframe sandbox="allow-scripts">`,
 *     never as the page itself. No `allow-same-origin`: that is what gives the
 *     frame an opaque origin, so the model's JS cannot read the `auth-token`
 *     cookie, call `/api/*` with the visitor's credentials, or touch the app's
 *     storage. It reaches the frame only as a quoted `srcdoc` attribute, and
 *     escaping `"` and `&` is what makes breaking out of it impossible.
 *  2. every artifact document carries `PREVIEW_CSP` as a `<meta>` FIRST inside
 *     the (possibly implied) head — a meta CSP anywhere else is ignored, and
 *     then the artifact can beacon whatever the conversation put in it back out.
 *
 * `buildArtifactDoc()` is the picker-less twin of
 * `client/src/lib/artifacts.js#buildPreviewDoc`; the same document shapes are
 * asserted in artifactPage.test.js here and artifacts.test.js there. Keep the
 * two in sync — a published page that loses the CSP is the same bug as a
 * preview that loses it, only reachable by strangers.
 */

const PREVIEW_CSP = [
  "default-src 'none'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data:',
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;

export const escapeHtml = (text) =>
  String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Puts the CSP meta first inside the document's (possibly implied) head, before
 * any of the model's own markup.
 */
function withCsp(doc) {
  const bodyAt = doc.search(/<body[\s>]/i);
  const beforeBody = (m) => m && (bodyAt === -1 || m.index < bodyAt);

  const head = doc.match(/<head\b[^>]*>/i);
  if (beforeBody(head)) {
    const at = head.index + head[0].length;
    return doc.slice(0, at) + CSP_META + doc.slice(at);
  }
  const html = doc.match(/<html\b[^>]*>/i);
  if (beforeBody(html)) {
    const at = html.index + html[0].length;
    return `${doc.slice(0, at)}<head>${CSP_META}</head>${doc.slice(at)}`;
  }
  const doctype = doc.match(/<!DOCTYPE[^>]*>/i);
  if (doctype && doctype.index === 0) {
    const at = doctype[0].length;
    return doc.slice(0, at) + CSP_META + doc.slice(at);
  }
  return CSP_META + doc;
}

/** The artifact itself as a complete, locked-down document. */
export function buildArtifactDoc(artifact) {
  if (!artifact?.code) return '';
  const code = artifact.code;

  if (artifact.language === 'svg') {
    return `<!DOCTYPE html>
<html><head>${CSP_META}<meta charset="utf-8"><style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #fff; }
  svg { max-width: 96vw; max-height: 96vh; }
</style></head><body>${code}</body></html>`;
  }
  if (/^\s*(<!DOCTYPE|<html)/i.test(code)) return withCsp(code);
  return `<!DOCTYPE html>
<html><head>${CSP_META}<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 16px; }</style>
</head><body>${code}</body></html>`;
}

/**
 * The wrapper page: nothing but a full-bleed sandboxed frame. It deliberately
 * carries no app script, no session and no chrome — a shared link should render
 * the artifact and nothing else.
 */
export function renderArtifactPage(artifact) {
  const title = escapeHtml(artifact?.title || 'artifact');
  const doc = escapeHtml(buildArtifactDoc(artifact));
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>html,body{margin:0;height:100%;background:#fff}iframe{display:block;border:0;width:100%;height:100%}</style>
</head><body><iframe title="${title}" sandbox="allow-scripts" srcdoc="${doc}"></iframe></body></html>`;
}

/**
 * Shown for a link that is wrong, deleted, or private and not yours — one page
 * for all three on purpose, so a stranger can't use the difference to learn
 * that a given id exists.
 */
export function renderMissingPage() {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Artifact not available</title>
<style>
  html,body{margin:0;height:100%}
  body{display:grid;place-items:center;background:#0b0b0f;color:#e4e4e7;
       font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;padding:24px}
  .card{max-width:26rem;text-align:center}
  h1{font-size:1.125rem;font-weight:600;margin:0 0 .5rem}
  p{font-size:.875rem;line-height:1.6;color:#a1a1aa;margin:0 0 1.5rem}
  a{display:inline-block;padding:.55rem 1rem;border-radius:.6rem;background:#4f46e5;
    color:#fff;text-decoration:none;font-size:.8125rem;font-weight:600}
</style>
</head><body><div class="card">
<h1>This artifact isn't available</h1>
<p>The link may be mistyped or deleted &mdash; or it's still private, and only its
owner can open it until they turn on sharing.</p>
<a href="/">Go to PromptMux</a>
</div></body></html>`;
}
