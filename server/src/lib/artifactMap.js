/**
 * A numbered outline of an artifact — the "table of contents" sent with the code
 * so a model editing a 600-line game knows where things are before it quotes
 * anything.
 *
 * This is deliberately a line scanner and not a parser. One artifact is HTML,
 * CSS and JS in the same file, the only consumer is a language model reading
 * prose, and a wrong guess costs a slightly worse outline — never a wrong edit,
 * because the patch itself is anchored to quoted text (lib/patch.js), not to
 * anything in here. Keeping it dependency-free also keeps it away from
 * client/src/lib/htmlNodes.js, whose offsets point-and-edit depends on.
 */

const STYLE_OPEN = /<style\b/i;
const STYLE_CLOSE = /<\/style\s*>/i;
const SCRIPT_OPEN = /<script\b/i;
const SCRIPT_CLOSE = /<\/script\s*>/i;

const FUNCTION = /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/;
const ARROW = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/;
const FUNCTION_EXPR = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/;
const CLASS = /^\s*class\s+([A-Za-z_$][\w$]*)/;
// Only a DECORATED comment counts as a heading — `// ==== physics ====` or
// `// ---- physics`. Treating every comment as a section would shred the outline.
const SECTION = /^\s*\/\/\s*[=\-—]{3,}\s*(.+?)\s*(?:[=\-—]{3,})?\s*$/;
const ELEMENT_ID = /<([a-zA-Z][\w-]*)\b[^>]*\sid\s*=\s*["']([^"']+)["']/;

const MAX_PARTS = 40;

/**
 * Splits artifact source into named, non-overlapping parts, each with 1-based
 * line numbers. Returns `[{ n, kind, name, startLine, endLine, lines }]`.
 */
export function buildArtifactMap(code) {
  if (typeof code !== 'string' || !code.trim()) return [];
  const lines = code.split('\n');
  const parts = [];
  let open = null;
  let mode = 'markup';

  const close = (endLine) => {
    if (!open) return;
    open.endLine = Math.max(open.startLine, endLine);
    open.lines = open.endLine - open.startLine + 1;
    parts.push(open);
    open = null;
  };
  const start = (kind, name, startLine) => {
    open = { kind, name, startLine, endLine: startLine, lines: 1 };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const at = i + 1;

    if (mode === 'markup') {
      if (STYLE_OPEN.test(line)) {
        close(i);
        start('style', 'styles', at);
        mode = 'style';
        // A one-line <style>…</style> opens and closes here.
        if (STYLE_CLOSE.test(line.slice(line.search(STYLE_OPEN)))) {
          close(at);
          mode = 'markup';
        }
        continue;
      }
      if (SCRIPT_OPEN.test(line)) {
        close(i);
        start('script', 'script — setup', at);
        mode = 'script';
        if (SCRIPT_CLOSE.test(line.slice(line.search(SCRIPT_OPEN)))) {
          close(at);
          mode = 'markup';
        }
        continue;
      }
      const id = ELEMENT_ID.exec(line);
      if (id) {
        close(i);
        start('markup', `#${id[2]} <${id[1].toLowerCase()}>`, at);
        continue;
      }
      if (!open) start('markup', 'markup', at);
      continue;
    }

    if (mode === 'style') {
      if (STYLE_CLOSE.test(line)) {
        close(at);
        mode = 'markup';
      }
      continue;
    }

    // mode === 'script'
    if (SCRIPT_CLOSE.test(line)) {
      close(at);
      mode = 'markup';
      continue;
    }
    const named =
      FUNCTION.exec(line) || FUNCTION_EXPR.exec(line) || ARROW.exec(line) || CLASS.exec(line);
    if (named) {
      close(i);
      const isClass = CLASS.test(line) && !FUNCTION.test(line);
      start('js', isClass ? `class ${named[1]}` : `${named[1]}()`, at);
      continue;
    }
    const section = SECTION.exec(line);
    if (section && section[1].length <= 48) {
      close(i);
      start('js', section[1], at);
      continue;
    }
    if (!open) start('js', 'script', at);
  }
  close(lines.length);

  // Too many parts is as useless as none. Structure survives; the per-id markup
  // rows are the first thing to go, since the code itself is right there anyway.
  let kept = parts;
  if (kept.length > MAX_PARTS) kept = kept.filter((p) => p.kind !== 'markup');
  if (kept.length > MAX_PARTS) kept = kept.slice(0, MAX_PARTS);

  return kept.map((p, idx) => ({ ...p, n: idx + 1 }));
}

/** The outline as compact text for the prompt. Empty string when not worth sending. */
export function renderArtifactMap(parts) {
  if (!parts || parts.length < 2) return '';
  return parts
    .map((p) => `${p.n}. lines ${p.startLine}-${p.endLine} — ${p.name} (${p.lines} lines)`)
    .join('\n');
}
