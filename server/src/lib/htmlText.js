/**
 * HTML -> plain text for provider pricing pages, so an LLM can read the prices
 * without paying for markup.
 *
 * Pricing is nearly always in a <table>, so table structure is the one thing
 * that must survive: cells come out pipe-separated and a row stays on a single
 * line ("GPT-4.1 | $2.00 | $8.00"). A row broken across lines, or cells run
 * together, is what makes a model read an input price as an output price.
 *
 * Pure string/regex work on purpose: a DOM parser would be a new dependency for
 * one feature, and these pages run to megabytes — so every pass below is a
 * single scan with no nested quantifiers that could blow up on large input.
 */

// Placeholders that survive tag stripping, so cell/row boundaries can still be
// located after all markup is gone (needed to fold a multi-line cell back onto
// its row). Control characters are stripped from the input first, so a page
// cannot forge them.
const CELL = '\x01';
const ROW = '\x02';

const DROP_ELEMENTS =
  'script|style|noscript|svg|iframe|template|head|nav|footer|form|button|select';
const DROP_RE = new RegExp(`<(${DROP_ELEMENTS})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi');
const DROP_SELF_CLOSING_RE = new RegExp(`<(?:${DROP_ELEMENTS})\\b[^>]*\\/>`, 'gi');

const BLOCK_ELEMENTS =
  'address|article|aside|blockquote|caption|dd|div|dl|dt|fieldset|figcaption|figure|' +
  'h1|h2|h3|h4|h5|h6|header|hgroup|hr|li|main|ol|p|pre|section|table|tbody|tfoot|thead|ul';
// `p` sitting before `pre` is safe: \b forces a backtrack into the longer name.
const BLOCK_RE = new RegExp(`<\\/?(?:${BLOCK_ELEMENTS})\\b[^>]*>`, 'gi');

const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const CDATA_RE = /<!\[CDATA\[[\s\S]*?\]\]>/g;
const DECLARATION_RE = /<![^>]*>/g;
const BR_RE = /<br\b[^>]*>/gi;
const CELL_RE = /<\/?(?:td|th)\b[^>]*>/gi;
const ROW_RE = /<\/?tr\b[^>]*>/gi;
const TAG_RE = /<[^>]*>/g;
const TITLE_RE = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i;
const WIDE_SPACE_RE = new RegExp('[\\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000]', 'g');
const ZERO_WIDTH_RE = new RegExp('[\\u00ad\\u200b-\\u200d\\u2060\\ufeff]', 'g');

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  shy: '',
  mdash: '—',
  ndash: '–',
  minus: '−',
  times: '×',
  divide: '÷',
  plusmn: '±',
  le: '≤',
  ge: '≥',
  ne: '≠',
  infin: '∞',
  deg: '°',
  rarr: '→',
  larr: '←',
  harr: '↔',
  hellip: '…',
  bull: '•',
  middot: '·',
  dollar: '$',
  cent: '¢',
  euro: '€',
  pound: '£',
  yen: '¥',
  copy: '©',
  reg: '®',
  trade: '™',
  sect: '§',
  dagger: '†',
  permil: '‰',
  prime: '′',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  laquo: '«',
  raquo: '»',
  sup1: '¹',
  sup2: '²',
  sup3: '³',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
};

// Numeric references in 0x80-0x9f are invalid HTML, but real pages emit them
// (&#146; for a curly apostrophe) and browsers map them through Windows-1252.
const CP1252 = {
  0x82: '‚', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡',
  0x88: 'ˆ', 0x89: '‰', 0x8b: '‹', 0x91: '‘', 0x92: '’',
  0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
  0x98: '˜', 0x99: '™', 0x9b: '›',
};

const ENTITY_RE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,30}));/g;

function fromCodePoint(code) {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return null;
  if (code >= 0xd800 && code <= 0xdfff) return null; // lone surrogate
  if (Object.hasOwn(CP1252, code)) return CP1252[code];
  return String.fromCodePoint(code);
}

export function decodeEntities(text) {
  if (typeof text !== 'string') return '';
  if (!text.includes('&')) return text;
  // One pass, so &amp;lt; decodes to the literal "&lt;" and not to "<".
  return text.replace(ENTITY_RE, (full, dec, hex, name) => {
    if (dec !== undefined) return fromCodePoint(Number.parseInt(dec, 10)) ?? full;
    if (hex !== undefined) return fromCodePoint(Number.parseInt(hex, 16)) ?? full;
    if (Object.hasOwn(NAMED_ENTITIES, name)) return NAMED_ENTITIES[name];
    const lower = name.toLowerCase();
    return Object.hasOwn(NAMED_ENTITIES, lower) ? NAMED_ENTITIES[lower] : full;
  });
}

/**
 * Makes an MDX/markdown docs page readable as plain text.
 *
 * Many vendor docs serve a `.md` twin of every page, which is a far better source
 * than the rendered HTML — except that MDX pages embed React. Kimi's pricing
 * table is the motivating case: it arrives as
 *
 *   ["kimi-k3", "1M tokens", <>{"$"}0.30</>, <>{"$"}3.00</>, <>{"$"}15.00</>, ...]
 *
 * preceded by ~700 characters of component definition. Unwrapping the fragments
 * and string expressions turns that into `["kimi-k3", "1M tokens", $0.30, $3.00,
 * $15.00, ...]`, and dropping the component saves tokens on every fetch.
 *
 * Only ever applied to non-HTML content — HTML goes through htmlToText instead.
 */
export function stripMdxArtifacts(text) {
  if (typeof text !== 'string' || !text) return '';
  return (
    text
      // Inline component definitions: `export const X = ... };` through to a line
      // that is just `};`. Non-greedy so several definitions each match their own.
      .replace(/^export\s+(?:const|default|let|var|function)\b[\s\S]*?^\};?[ \t]*$/gm, '')
      // JSX fragments: `<>anything</>` -> `anything`
      .replace(/<>\s*([\s\S]*?)\s*<\/>/g, '$1')
      // String expressions: `{"$"}` -> `$`, `{'x'}` -> `x`
      .replace(/\{\s*"([^"\n]*)"\s*\}/g, '$1')
      .replace(/\{\s*'([^'\n]*)'\s*\}/g, '$1')
      // Import lines are pure noise in extracted text.
      .replace(/^import\s+[^\n]*from\s+['"][^'"\n]*['"];?[ \t]*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

export function htmlTitle(html) {
  if (typeof html !== 'string') return null;
  const match = TITLE_RE.exec(html);
  if (!match) return null;
  const title = decodeEntities(match[1].replace(TAG_RE, '')).replace(/\s+/g, ' ').trim();
  return title || null;
}

/**
 * A cell built from block markup (<td><div>GPT-4.1</div></td>) carries newlines
 * by the time we get here; inside a row those have to become spaces, or the row
 * splits over several lines and the price stops being attributable to a model.
 */
function foldRows(text) {
  if (!text.includes(ROW)) return text;
  return text
    .split(ROW)
    .map((segment) => (segment.includes(CELL) ? segment.replace(/\n+/g, ' ') : segment))
    .join('\n');
}

/**
 * Both the opening and the closing cell tag left a marker, so `</td><td>` shows
 * up as one empty piece while `<td></td>` between two cells shows up as three:
 * a run of k empty pieces means (k - 1) / 2 genuinely empty cells. Keeping those
 * matters — a blank "cached input" cell that silently disappeared would shift
 * every following price one column left of its header.
 */
function rowToLine(row) {
  const cells = [];
  let gap = 0;
  for (const piece of row.split(CELL)) {
    const cell = piece.replace(/[ \t]+/g, ' ').trim();
    if (cell === '') {
      gap += 1;
      continue;
    }
    for (let empty = (gap - 1) >> 1; empty > 0; empty -= 1) cells.push('');
    cells.push(cell);
    gap = 0;
  }
  if (!cells.length) return '';
  for (let empty = (gap - 1) >> 1; empty > 0; empty -= 1) cells.push('');
  return cells.join(' | ').trim();
}

function extractText(html) {
  const stripped = html
    .replace(CONTROL_RE, '')
    .replace(COMMENT_RE, '')
    .replace(CDATA_RE, '')
    .replace(DROP_RE, '\n')
    .replace(DROP_SELF_CLOSING_RE, '\n')
    .replace(DECLARATION_RE, '')
    .replace(BR_RE, '\n')
    .replace(CELL_RE, CELL)
    .replace(ROW_RE, ROW)
    .replace(BLOCK_RE, '\n')
    .replace(TAG_RE, ''); // inline tags add no space: <span>$2</span><span>.00</span>

  const decoded = decodeEntities(stripped)
    .replace(/\r\n?/g, '\n')
    // Pricing tables pad numbers with non-breaking and thin spaces; the model
    // should see ordinary ones so a price never arrives glued to its unit.
    .replace(WIDE_SPACE_RE, ' ')
    .replace(ZERO_WIDTH_RE, '')
    .replace(/\n{3,}/g, '\n\n');

  const lines = [];
  for (const raw of foldRows(decoded).split('\n')) {
    const line = raw.includes(CELL) ? rowToLine(raw) : raw.replace(/[ \t]+/g, ' ').trim();
    if (line) lines.push(line);
  }
  return lines.join('\n');
}

/**
 * `chars` is the length of the full extraction, not of `text` — callers store it
 * so an admin can see how much of the page the model actually got to read.
 */
export function htmlToText(html, { maxChars = 60000 } = {}) {
  const full = typeof html === 'string' ? extractText(html) : '';
  const chars = full.length;
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : chars;
  if (chars <= limit) return { text: full, chars, truncated: false };

  const cut = full.slice(0, limit);
  const lastBreak = cut.lastIndexOf('\n');
  // No break at all means the first line already exceeds the budget, and a hard
  // cut is the only option left.
  return { text: lastBreak > 0 ? cut.slice(0, lastBreak) : cut, chars, truncated: true };
}
