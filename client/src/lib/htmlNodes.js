/**
 * Source-accurate HTML element scanner.
 *
 * Point-and-edit needs to answer one question: "the user clicked THIS element in
 * the preview — which exact characters of the artifact source produced it?"
 * A DOM parser can't say (it throws source positions away), so we scan the raw
 * text ourselves and record, per element, the offsets of its opening `<` and of
 * the character after its closing `>`. Each element also gets an id, which is
 * stamped into the preview copy as `data-pm-node="<id>"`; the injected picker
 * script reads that attribute off the clicked node and posts the id back.
 *
 * Only the range matters for editing, so the scanner is deliberately tolerant:
 * it follows the HTML5 optional-end-tag rules (an open `<li>` is closed by the
 * next `<li>`, a `<p>` by any block start, ...) and pops through mismatched
 * close tags, because getting the END offset wrong is what would make an edit
 * clobber a sibling.
 *
 * Deliberate spec-faithful choices (they keep ranges aligned with what the
 * browser actually built, which is what the user clicked):
 * - `<div/>` in HTML is an OPEN tag — the slash is ignored, per spec. Self
 *   closing only applies to void elements and to foreign content (svg/math).
 * - `<script>`, `<style>`, `<textarea>` and `<title>` are raw text: nothing
 *   inside them is scanned as markup.
 */

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);

// Structural / non-visual elements: scanned (offsets still tracked) but never
// offered as an edit target — you can't click them in a preview anyway.
const NOT_PICKABLE = new Set([
  'html', 'head', 'meta', 'link', 'base', 'script', 'style', 'title', 'br', 'wbr',
]);

// Foreign content: inside these, `<path />` really is self-closing.
const FOREIGN = new Set(['svg', 'math']);

// Block-level starts that implicitly close an open <p>.
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir',
  'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'listing', 'main', 'menu',
  'nav', 'ol', 'p', 'plaintext', 'pre', 'search', 'section', 'summary', 'table',
  'ul', 'xmp',
]);

// Which currently-open tags a newly opened tag implicitly closes.
// Table sections/rows/cells also close an open <caption>/<colgroup>, matching the
// parser's "clear the stack back to a table context" steps.
const IMPLICIT_CLOSE = {
  li: ['li'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  option: ['option'],
  optgroup: ['option', 'optgroup'],
  caption: ['caption', 'colgroup'],
  colgroup: ['caption', 'colgroup'],
  tr: ['td', 'th', 'tr', 'caption', 'colgroup'],
  td: ['td', 'th', 'caption', 'colgroup'],
  th: ['td', 'th', 'caption', 'colgroup'],
  tbody: ['td', 'th', 'tr', 'thead', 'tbody', 'caption', 'colgroup'],
  tfoot: ['td', 'th', 'tr', 'thead', 'tbody', 'caption', 'colgroup'],
  thead: ['td', 'th', 'tr', 'caption', 'colgroup'],
  rt: ['rt', 'rp'],
  rp: ['rt', 'rp'],
};

/**
 * Elements the implied-end-tag walk may NOT step past: the HTML5 "special"
 * category minus address/div/p, which the spec explicitly walks through. So
 * `<ul><li><div>x<li>` closes the first <li> (through the div), while
 * `<ul><li><ul><li>` does not (the inner <ul> stops the walk).
 */
const WALK_STOP = new Set([
  'applet', 'area', 'article', 'aside', 'base', 'basefont', 'bgsound', 'blockquote',
  'body', 'br', 'button', 'caption', 'center', 'col', 'colgroup', 'dd', 'details',
  'dir', 'dl', 'dt', 'embed', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hgroup', 'hr', 'html', 'iframe', 'img', 'input', 'keygen', 'li', 'link',
  'listing', 'main', 'marquee', 'menu', 'meta', 'nav', 'noembed', 'noframes',
  'noscript', 'object', 'ol', 'param', 'plaintext', 'pre', 'script', 'search',
  'section', 'select', 'source', 'style', 'summary', 'table', 'tbody', 'td',
  'template', 'textarea', 'tfoot', 'th', 'thead', 'title', 'tr', 'track', 'ul',
  'wbr', 'xmp',
]);

const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f']);

const TAG_NAME = /^[a-zA-Z][^\s/>]*/;

function closedBy(tag) {
  const list = IMPLICIT_CLOSE[tag] ? [...IMPLICIT_CLOSE[tag]] : [];
  if (CLOSES_P.has(tag)) list.push('p');
  return list;
}

/** Reads an attribute value out of an opening tag's source text. */
function attrValue(openTag, name) {
  const re = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>\`]+))`, 'i');
  const m = openTag.match(re);
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3] ?? '').trim() || null;
}

/** `div#hero.card.wide` — a short, human-readable handle for a target. */
function labelFor(tag, openTag) {
  const id = attrValue(openTag, 'id');
  const cls = attrValue(openTag, 'class');
  let label = tag;
  if (id) label += `#${id}`;
  if (cls) {
    const classes = cls.split(/\s+/).filter(Boolean).slice(0, 2);
    if (classes.length) label += `.${classes.join('.')}`;
  }
  return label.length > 60 ? `${label.slice(0, 57)}…` : label;
}

/**
 * Scans HTML source into a flat list of elements, in document order of their
 * opening tags. Each node:
 *   { id, tag, openStart, openEnd, start, end, depth, parent, pickable, label }
 * `start`/`end` bracket the whole element (open tag through close tag), so
 * `code.slice(start, end)` is exactly what an edit replaces.
 */
export function scanHtmlNodes(code) {
  const nodes = [];
  if (typeof code !== 'string' || !code) return nodes;
  const len = code.length;
  const stack = []; // open elements, innermost last
  let i = 0;

  const closeNode = (node, end) => {
    node.end = Math.min(end, len);
  };

  while (i < len) {
    const lt = code.indexOf('<', i);
    if (lt === -1) break;
    const next = code[lt + 1];

    // Comment / doctype / processing instruction — skipped wholesale.
    if (next === '!') {
      if (code.startsWith('<!--', lt)) {
        const close = code.indexOf('-->', lt + 4);
        i = close === -1 ? len : close + 3;
      } else {
        const close = code.indexOf('>', lt);
        i = close === -1 ? len : close + 1;
      }
      continue;
    }
    if (next === '?') {
      const close = code.indexOf('>', lt);
      i = close === -1 ? len : close + 1;
      continue;
    }

    // Closing tag.
    if (next === '/') {
      const m = code.slice(lt + 2).match(TAG_NAME);
      if (!m) {
        i = lt + 2;
        continue;
      }
      const tag = m[0].toLowerCase();
      const gt = code.indexOf('>', lt);
      const afterClose = gt === -1 ? len : gt + 1;
      // Find the nearest matching open element; anything above it was left
      // unclosed, so it ends where this close tag starts.
      let at = -1;
      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s].tag === tag) {
          at = s;
          break;
        }
      }
      if (at === -1) {
        i = afterClose; // stray close tag — ignore it
        continue;
      }
      for (let s = stack.length - 1; s > at; s--) closeNode(stack[s], lt);
      closeNode(stack[at], afterClose);
      stack.length = at;
      i = afterClose;
      continue;
    }

    // Opening tag.
    const m = code.slice(lt + 1).match(TAG_NAME);
    if (!m) {
      i = lt + 1; // a bare "<" in text
      continue;
    }
    const tag = m[0].toLowerCase();

    // Walk to the end of the opening tag, stepping over quoted attribute VALUES so
    // a ">" inside one doesn't end the tag early. A quote only opens a value when
    // it follows "=", exactly like the tokenizer: in `onclick='f("It\'s")'` the
    // value ends at the escaped apostrophe and the later `"` is just a character
    // in an attribute name — treating it as a delimiter would run to end of file.
    let j = lt + 1 + m[0].length;
    let slashBeforeGt = false;
    let inValue = false;
    while (j < len) {
      const ch = code[j];
      if (ch === '>') {
        slashBeforeGt = code[j - 1] === '/';
        break;
      }
      if (ch === '=') {
        inValue = true;
        j++;
        continue;
      }
      if (WHITESPACE.has(ch)) {
        j++;
        continue;
      }
      if (inValue && (ch === '"' || ch === "'")) {
        const q = code.indexOf(ch, j + 1);
        j = q === -1 ? len : q + 1;
        inValue = false;
        continue;
      }
      inValue = false;
      j++;
    }
    const openEnd = Math.min(j + 1, len);
    const openTag = code.slice(lt, openEnd);

    // An open tag can implicitly close open siblings/ancestors. Walk DOWN the
    // stack for the deepest closable match (stopping at a WALK_STOP element) —
    // only checking the top would miss `<ul><li><p>a<li>`, where the second <li>
    // must close both the <p> and the first <li> instead of nesting inside them.
    const closes = closedBy(tag);
    if (closes.length && stack.length) {
      let matchAt = -1;
      for (let s = stack.length - 1; s >= 0; s--) {
        if (closes.includes(stack[s].tag)) {
          matchAt = s;
          continue;
        }
        if (WALK_STOP.has(stack[s].tag)) break;
      }
      if (matchAt !== -1) {
        for (let s = stack.length - 1; s >= matchAt; s--) closeNode(stack[s], lt);
        stack.length = matchAt;
      }
    }

    const node = {
      id: nodes.length,
      tag,
      openStart: lt,
      openEnd,
      start: lt,
      end: openEnd, // provisional; overwritten when the element closes
      depth: stack.length,
      parent: stack.length ? stack[stack.length - 1].id : -1,
      pickable: !NOT_PICKABLE.has(tag),
      label: labelFor(tag, openTag),
    };
    nodes.push(node);

    if (RAW_TEXT.has(tag)) {
      // Nothing inside is markup: jump straight past the matching close tag.
      const closeRe = new RegExp(`</${tag}\\s*>`, 'i');
      const rest = code.slice(openEnd);
      const found = rest.search(closeRe);
      if (found === -1) {
        node.end = len;
        i = len;
      } else {
        const closeMatch = rest.slice(found).match(closeRe);
        node.end = openEnd + found + closeMatch[0].length;
        i = node.end;
      }
      continue;
    }

    // "/>" self-closes only for void elements and inside foreign content (svg/math);
    // in HTML the slash is ignored, so <div/> stays open. Derived from the live stack
    // rather than a counter, which could go stale when a mismatched close tag pops an
    // <svg> and would then wrongly self-close later HTML elements.
    const inForeign = FOREIGN.has(tag) || stack.some((n) => FOREIGN.has(n.tag));
    const selfCloses = VOID.has(tag) || (slashBeforeGt && inForeign);
    if (selfCloses) {
      node.end = openEnd;
      i = openEnd;
      continue;
    }

    stack.push(node);
    i = openEnd;
  }

  // Anything still open runs to the end of the source.
  for (const node of stack) closeNode(node, len);
  return nodes;
}

/**
 * Returns a copy of `code` with `data-pm-node="<id>"` stamped into every
 * pickable element's opening tag. Offsets in the ORIGINAL code stay valid —
 * only the preview copy carries the attribute, and edits always splice the
 * original.
 */
export function annotateHtml(code) {
  const nodes = scanHtmlNodes(code);
  let out = code;
  for (let k = nodes.length - 1; k >= 0; k--) {
    const node = nodes[k];
    if (!node.pickable) continue;
    const at = node.openStart + 1 + node.tag.length;
    out = `${out.slice(0, at)} data-pm-node="${node.id}"${out.slice(at)}`;
  }
  return out;
}

/** Splices a replacement fragment over a node's source range. */
export function replaceRange(code, start, end, replacement) {
  return code.slice(0, start) + replacement + code.slice(end);
}
