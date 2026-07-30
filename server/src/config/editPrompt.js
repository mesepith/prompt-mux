/**
 * Prompting for point-and-edit: the user clicks one element in the artifact
 * preview, says what to change, and the model rewrites ONLY that element.
 *
 * The whole point is that the model does not regenerate the document, so the
 * prompt is deliberately narrow: full document as read-only context, the exact
 * target fragment, one instruction, and a hard requirement to reply with just
 * the replacement markup.
 */

export const EDIT_SYSTEM_PROMPT = `You are a precise HTML/SVG editor inside PromptMux. You rewrite exactly ONE fragment of a larger document.

Rules:
1. Reply with ONLY the replacement markup for the target fragment. No explanation, no markdown code fences, no <html>/<head>/<body> wrapper, nothing before or after the markup.
2. Change only what the instruction asks for. Preserve every attribute, class, id, inline style, child element, text and whitespace you were not asked to change.
3. Keep the same outer tag unless the instruction clearly requires a different one, and keep existing id/class values so the document's CSS and JS keep working.
4. If the change needs new styling, put it in an inline style attribute, reuse existing classes, or include a small <style> element inside your fragment. Never restate the document's whole stylesheet.
5. Keep the fragment self-contained and valid: every tag you open, you close.
6. If the instruction cannot be satisfied by editing this fragment alone, reply with the fragment unchanged.`;

const MAX_CONTEXT = 40_000; // chars of document sent in full
const WINDOW = 12_000; // chars kept either side of the target when trimming
const HEAD_KEEP = 3_000; // keep the top of the file (usually <head>/<style>)

/**
 * Document context for the prompt. Big artifacts are windowed around the target
 * so a small edit stays a small request — the head is kept because that's where
 * the styles the fragment depends on usually live.
 */
function documentContext(code, start, end) {
  if (code.length <= MAX_CONTEXT) return code;
  const from = Math.max(0, start - WINDOW);
  const to = Math.min(code.length, end + WINDOW);
  const parts = [];
  if (from > HEAD_KEEP) {
    parts.push(code.slice(0, HEAD_KEEP), '\n…[document trimmed]…\n');
  }
  parts.push(code.slice(from > HEAD_KEEP ? from : 0, to));
  if (to < code.length) parts.push('\n…[document trimmed]…');
  return parts.join('');
}

export function buildEditPrompt({ code, start, end, snippet, instruction, language, targetLabel }) {
  const context = documentContext(code, start, end);
  return [
    `Here is the ${language.toUpperCase()} document being edited (read-only context):`,
    '',
    context,
    '',
    `The target fragment${targetLabel ? ` (<${targetLabel}>)` : ''} — this exact text is what you must replace:`,
    '',
    snippet,
    '',
    `Instruction from the user: ${instruction}`,
    '',
    'Reply with only the replacement markup for that fragment.',
  ].join('\n');
}

/**
 * Turns a model reply into a fragment we can splice, or throws with a message
 * the user can act on. Models sometimes wrap the answer in a fence or add a
 * sentence of prose — both are recoverable. Returning the entire document is
 * not: that's the failure mode this whole feature exists to avoid, so it's
 * rejected rather than silently applied.
 */
export function cleanFragment(raw, snippet) {
  let out = (raw || '').trim();
  if (!out) throw new Error('The model returned an empty edit — try rewording the instruction.');

  // Unwrap only a fence the model wrapped the WHOLE reply in — a fence in the
  // middle may well be part of the fragment (e.g. a <pre> showing markdown).
  if (out.startsWith('```')) {
    const whole = out.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)```\s*$/);
    out = (whole ? whole[1] : out.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/```\s*$/, '')).trim();
  }

  const wantsMarkup = snippet.trimStart().startsWith('<');
  if (wantsMarkup && !out.startsWith('<')) {
    const first = out.indexOf('<');
    if (first === -1)
      throw new Error('The model replied with prose instead of markup — try rewording the instruction.');
    out = out.slice(first).trim();
  }
  if (wantsMarkup) {
    const lastGt = out.lastIndexOf('>');
    if (lastGt !== -1 && lastGt < out.length - 1) out = out.slice(0, lastGt + 1);
  }

  const snippetIsDoc = /<(!doctype|html)\b/i.test(snippet);
  if (!snippetIsDoc && /<(!doctype|html)\b/i.test(out))
    throw new Error(
      'The model rewrote the whole document instead of the selected part — nothing was changed. Try a more specific instruction.'
    );
  if (out.length > 400_000) throw new Error('The model returned an implausibly large edit — nothing was changed.');
  // The artifact is stored inside a ```html fence, so a fragment containing one
  // would truncate the artifact for every future read. Refuse rather than corrupt.
  if (out.includes('```'))
    throw new Error(
      'The edit contained a markdown code fence, which would corrupt the artifact — nothing was changed.'
    );

  return out;
}

/** First tag name in a fragment, for reporting when the model swapped the tag. */
export function rootTag(fragment) {
  const m = (fragment || '').match(/^\s*<\s*([a-zA-Z][^\s/>]*)/);
  return m ? m[1].toLowerCase() : null;
}
