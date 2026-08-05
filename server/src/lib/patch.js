/**
 * SEARCH/REPLACE patches — how a chat message changes an artifact without the
 * model rewriting it.
 *
 * This is the same invariant point-and-edit already lives by (AGENTS.md): *the
 * model writes a fragment, the server decides where it goes*. The difference is
 * that here the fragment brings its own anchor — the exact lines it replaces —
 * so the server's whole job is to find that anchor, and to refuse when it can't:
 *
 *   not found    -> refuse. The model quoted code that isn't in the document.
 *   found twice  -> refuse. Editing the wrong copy silently breaks a working
 *                   game, which is worse than doing nothing at all.
 *   found once   -> splice.
 *
 * Refusing is cheap because the caller falls back (a repair attempt, then a full
 * rewrite), so a rejected patch costs tokens and never correctness. Application
 * is ALL-OR-NOTHING for the same reason: a half-applied edit is the one outcome
 * the user cannot recover from.
 *
 * Nothing here knows about HTML. It is line/​text surgery, which is exactly why
 * it works on the `<script>` bodies that point-and-edit cannot touch (script and
 * style are NOT_PICKABLE in client/src/lib/htmlNodes.js) — the reason a game gets
 * rewritten from scratch for every "make the jump higher".
 */

// Deliberately tolerant: models drift on marker length and drop the SEARCH /
// REPLACE words. What must stay strict is that a marker owns its whole line —
// that is what keeps a `// =====` comment inside quoted code from being read as
// a divider.
const SEARCH_OPEN = /^<{5,}\s*(SEARCH)?\s*$/;
const DIVIDER = /^={5,}\s*$/;
const REPLACE_CLOSE = /^>{5,}\s*(REPLACE)?\s*$/;
const WRAPPER_FENCE = /^```(patch|diff)?\s*$/;

/**
 * Where a streaming reply stops being prose and starts being edit blocks.
 *
 * The SSE stream forwards tokens live, and nobody wants to watch
 * `<<<<<<< SEARCH` scroll past — so the route stops forwarding here and shows a
 * status instead. Returns -1 while the reply still looks like an ordinary answer.
 */
const MARKER_SNIFF = /(?:^|\n)[ \t]*(?:<{5,}|```(?:patch|diff)[ \t]*(?:\n|$))/;

/**
 * Hold this many trailing characters back while sniffing, so a marker split
 * across two deltas can't slip through half-emitted. Detection itself always
 * runs against the whole accumulated reply, so this only bounds how much of a
 * partial marker could be shown as prose — 24 covers the longest form the regex
 * accepts (a newline, indentation, then ```patch).
 */
export const SNIFF_HOLDBACK = 24;

export function patchMarkerIndex(text) {
  const found = MARKER_SNIFF.exec(text);
  return found ? found.index : -1;
}

const rtrim = (line) => line.replace(/\s+$/, '');
const indentOf = (line) => (/^[ \t]*/.exec(line) || [''])[0];
const firstMeaningful = (lines) => lines.find((l) => l.trim() !== '');
const atLineStart = (text, i) => i === 0 || text[i - 1] === '\n';
const atLineEnd = (text, i) => i === text.length || text[i] === '\n';

/**
 * Splits a model reply into its prose and its edit blocks.
 *
 * Returns `{ prose, blocks: [{ search, replace }], problems: [string] }`.
 * `problems` describes malformed blocks in words the repair prompt can hand
 * straight back to the model. No blocks means "this reply isn't a patch" — the
 * caller then treats it as an ordinary answer, which is what keeps a model that
 * ignores the format working exactly as it does today.
 */
export function parsePatch(raw) {
  const text = String(raw || '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const blocks = [];
  const prose = [];
  const problems = [];

  let state = 'prose';
  let search = [];
  let replace = [];

  const abandon = (why) => {
    problems.push(why);
    state = 'prose';
    search = [];
    replace = [];
  };

  for (const line of lines) {
    const marker = line.trim();

    if (state === 'prose') {
      if (SEARCH_OPEN.test(marker)) {
        state = 'search';
        search = [];
        replace = [];
      } else {
        prose.push(line);
      }
      continue;
    }

    if (state === 'search') {
      if (DIVIDER.test(marker)) {
        state = 'replace';
        continue;
      }
      // A second opener, or a close with no divider, means the block never had a
      // REPLACE half. Drop it rather than guess which side the lines belonged to.
      if (SEARCH_OPEN.test(marker) || REPLACE_CLOSE.test(marker)) {
        abandon('an edit block had no ======= divider between SEARCH and REPLACE');
        if (SEARCH_OPEN.test(marker)) state = 'search';
        continue;
      }
      search.push(line);
      continue;
    }

    // state === 'replace'
    if (REPLACE_CLOSE.test(marker)) {
      if (search.length === 0) problems.push('an edit block had an empty SEARCH section');
      else blocks.push({ search: search.join('\n'), replace: replace.join('\n') });
      state = 'prose';
      search = [];
      replace = [];
      continue;
    }
    if (SEARCH_OPEN.test(marker)) {
      abandon('an edit block was never closed with >>>>>>> REPLACE');
      state = 'search';
      continue;
    }
    replace.push(line);
  }

  if (state !== 'prose') problems.push('the last edit block was cut off before it closed');

  // The ```patch wrapper is chrome, not something to show the user — but only
  // strip fences once we know this really is a patch reply, or a model that
  // answered with a normal ```html artifact would lose its fence.
  const proseLines = blocks.length
    ? prose.filter((line) => !WRAPPER_FENCE.test(line.trim()))
    : prose;

  return { prose: proseLines.join('\n').trim(), blocks, problems };
}

/** Every line index where `searchLines` matches, under a normalizing comparison. */
function lineMatches(codeLines, searchLines, normalize) {
  const hits = [];
  const n = searchLines.length;
  if (n === 0 || n > codeLines.length) return hits;
  const needle = searchLines.map(normalize);
  for (let i = 0; i + n <= codeLines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (normalize(codeLines[i + j]) !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

/**
 * Re-indents a replacement to sit where the match actually sits.
 *
 * Only used by the indentation-insensitive strategy: the model matched on
 * content while writing, say, 2 spaces where the file uses 4.
 *
 * The mapping is OBSERVED, not guessed. Every line that just matched tells us
 * what one of the model's indentation levels corresponds to in the real file, so
 * a replacement line at the model's inner depth lands at the file's inner depth —
 * even when the two use different indent widths. Inferring "the file indents by
 * 4" from a single anchor would be a guess; this is evidence.
 */
function reindent(replaceLines, searchLines, codeLines, at) {
  const observed = new Map(); // model's indent string -> the file's
  for (let j = 0; j < searchLines.length; j++) {
    if (!searchLines[j].trim()) continue;
    const from = indentOf(searchLines[j]);
    if (!observed.has(from)) observed.set(from, indentOf(codeLines[at + j]));
  }
  if (observed.size === 0) return replaceLines;

  const base = indentOf(firstMeaningful(searchLines) ?? '');
  const want = observed.get(base) ?? base;

  return replaceLines.map((line) => {
    if (!line.trim()) return line;
    const own = indentOf(line);
    const body = line.slice(own.length);
    const mapped = observed.get(own);
    if (mapped !== undefined) return mapped + body;
    // A depth the model introduced that the SEARCH never showed us: shift it by
    // however far the base moved, so it stays nested against its neighbours.
    const relative = own.startsWith(base) ? own.slice(base.length) : own;
    return want + relative + body;
  });
}

/**
 * Applies one block. Three strategies, tried in order, all of them requiring a
 * UNIQUE match — the fallbacks exist to forgive whitespace drift, never to
 * loosen the "exactly one place" rule.
 */
function applyBlock(code, block) {
  const { search } = block;
  if (!search) return { ok: false, reason: 'the SEARCH section was empty' };
  // The artifact is stored inside a ```html fence, so a replacement containing a
  // fence would truncate it for every future read — the panel, point-and-edit and
  // published /a/<id> pages would all see a half document. Same guard
  // cleanFragment applies to point-and-edit replies, for the same reason.
  if (block.replace.includes('```'))
    return { ok: false, reason: 'the replacement contained a markdown code fence, which would corrupt the artifact' };

  // 1. Exact text. Also covers a match that is only part of a line, which is the
  //    common shape of a one-value change like `const JUMP = 8;`.
  const first = code.indexOf(search);
  if (first !== -1) {
    if (code.indexOf(search, first + 1) !== -1)
      return { ok: false, reason: 'those lines appear more than once — include a line or two either side to make them unique' };
    let from = first;
    let to = first + search.length;
    // Deleting whole lines must remove the lines, not leave a blank one where
    // they were — a stray blank line per deletion adds up over an editing session.
    if (block.replace === '' && atLineStart(code, from) && atLineEnd(code, to)) {
      if (code[to] === '\n') to += 1;
      else if (from > 0 && code[from - 1] === '\n') from -= 1;
    }
    return {
      ok: true,
      strategy: 'exact',
      code: code.slice(0, from) + block.replace + code.slice(to),
    };
  }

  const codeLines = code.split('\n');
  const searchLines = search.split('\n');
  // An empty REPLACE deletes the lines outright, rather than leaving a blank one.
  const replaceLines = block.replace === '' ? [] : block.replace.split('\n');

  for (const [strategy, normalize] of [
    ['trailing-space', rtrim],
    ['indent', (line) => line.trim()],
  ]) {
    const hits = lineMatches(codeLines, searchLines, normalize);
    if (hits.length > 1)
      return { ok: false, reason: 'those lines appear more than once — include a line or two either side to make them unique' };
    if (hits.length === 1) {
      const at = hits[0];
      const body = strategy === 'indent'
        ? reindent(replaceLines, searchLines, codeLines, at)
        : replaceLines;
      return {
        ok: true,
        strategy,
        code: [...codeLines.slice(0, at), ...body, ...codeLines.slice(at + searchLines.length)].join('\n'),
      };
    }
  }

  return { ok: false, reason: 'those lines are not in the document — copy them exactly as they appear' };
}

/**
 * Applies every block, or none of them.
 *
 * On success: `{ ok: true, code, applied }`. On failure: `{ ok: false, code }`
 * where `code` is the ORIGINAL, untouched, plus a `failures` list naming each
 * block that could not be placed and why.
 *
 * Blocks are applied in order against the evolving text, so a later block may
 * legitimately target something an earlier one produced.
 */
export function applyPatch(code, blocks, { minLength = 0 } = {}) {
  if (typeof code !== 'string' || !code)
    return { ok: false, code, applied: [], failures: [{ index: 0, reason: 'there is no artifact in this chat to edit' }] };
  if (!Array.isArray(blocks) || blocks.length === 0)
    return { ok: false, code, applied: [], failures: [{ index: 0, reason: 'no edit blocks were provided' }] };

  let out = code;
  const applied = [];
  const failures = [];

  for (let i = 0; i < blocks.length; i++) {
    const result = applyBlock(out, blocks[i]);
    if (!result.ok) {
      failures.push({ index: i, reason: result.reason, search: blocks[i].search });
      continue;
    }
    out = result.code;
    applied.push({ ...blocks[i], strategy: result.strategy });
  }

  // All-or-nothing. A document with two of three edits in it may be broken in a
  // way neither the user nor the model can reason about.
  if (failures.length) return { ok: false, code, applied: [], failures };

  // A result too small to BE an artifact is worse than a refused patch: the
  // fence would still be stored, extractArtifacts would skip it (under
  // MIN_ARTIFACT_CHARS), the panel would show nothing, and the next turn would
  // pick the PREVIOUS version — so the user would silently edit an old copy of
  // their game. Refuse and let the fallback chain deal with it.
  if (minLength && out.trim().length < minLength)
    return {
      ok: false,
      code,
      applied: [],
      failures: [
        {
          index: 0,
          reason: `the result would be only ${out.trim().length} characters, which would delete the artifact rather than edit it`,
        },
      ],
    };

  return { ok: true, code: out, applied, failures: [] };
}

/**
 * The hunks worth storing on the message for the transcript's diff.
 *
 * Bounded on purpose: the message already carries the full patched artifact, and
 * a pathological patch (a whole-document SEARCH, say) would store it a third
 * time. A Mongo document has 16MB to work with and losing the diff view is a far
 * better outcome than losing the message.
 */
const HUNK_STORE_MAX = 60_000;

export function hunksForStorage(applied) {
  const hunks = (applied || []).map((h) => ({ search: h.search, replace: h.replace }));
  const size = hunks.reduce((n, h) => n + h.search.length + h.replace.length, 0);
  return size > HUNK_STORE_MAX ? [] : hunks;
}

/** Lines added / removed, for the badge and the diff in the transcript. */
export function patchStats(applied) {
  let added = 0;
  let removed = 0;
  for (const hunk of applied || []) {
    removed += hunk.search === '' ? 0 : hunk.search.split('\n').length;
    added += hunk.replace === '' ? 0 : hunk.replace.split('\n').length;
  }
  return { hunks: (applied || []).length, added, removed };
}

/**
 * The failures, written for the model rather than for a log — this text goes
 * straight into the one repair attempt, so it names the exact lines that missed
 * and why.
 */
export function describeFailures(failures, problems = []) {
  const parts = [];
  for (const problem of problems) parts.push(`- ${problem}`);
  for (const failure of failures || []) {
    const quoted = String(failure.search || '').split('\n').slice(0, 6).join('\n');
    parts.push(`- ${failure.reason}${quoted ? `\nThe SEARCH section that failed was:\n${quoted}` : ''}`);
  }
  return parts.join('\n');
}
