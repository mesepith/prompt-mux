/**
 * Prompting for chat-driven artifact edits.
 *
 * A game is one 600-line HTML document, and until now "make the jump higher"
 * meant the model reproduced all 600 lines: slow, ~5k output tokens a turn, and
 * it silently redrew parts the user was happy with. Point-and-edit already
 * solved that for things you can click, but `<script>` and `<style>` are
 * deliberately not clickable (client/src/lib/htmlNodes.js), which is exactly
 * where a game's behaviour lives.
 *
 * So the same bargain is offered through the chat box: the model gets the live
 * source plus an outline, and answers with SEARCH/REPLACE blocks that the server
 * locates and splices (lib/patch.js). The model never has to be trusted to
 * reproduce the document, because it is never asked to.
 *
 * These rules are appended to SYSTEM_PROMPT only when the chat actually has an
 * artifact — no provider here uses prompt caching (checked: nothing sets
 * cache_control), so a per-conversation system prompt costs nothing.
 */

export const PATCH_RULES = `
EDITING THE LIVE ARTIFACT

This chat already has an artifact. Its current source is included with the user's message, with a numbered outline of its parts.

When the user asks you to change, fix, add or remove anything in it, DO NOT reproduce the document. Reply with one short sentence saying what you changed, then one edit block per change:

\`\`\`patch
<<<<<<< SEARCH
(lines copied exactly from the current source, including their indentation)
=======
(what those lines become)
>>>>>>> REPLACE
\`\`\`

Rules for edit blocks:
- The SEARCH lines must appear EXACTLY ONCE in the source. If what you need isn't unique, include a line or two above and below until it is.
- Keep SEARCH down to the lines that actually change. Never put the whole document in it.
- Use a separate block per change; several blocks in one reply is normal and preferred.
- To delete code, leave the REPLACE half empty.
- Do NOT emit a \`\`\`html or \`\`\`svg block while editing. Use one only when the user wants a brand-new artifact built from scratch.
- Never put a \`\`\` fence inside the REPLACE half — the artifact is stored inside a fence, and that would corrupt it.
- If the user is asking a question, or talking about something other than the artifact, just answer normally with no edit blocks.`;

/**
 * Hard ceiling on the source we inline. Well above any artifact a model actually
 * writes (a dense game is 20-40 KB); past this the source is truncated and the
 * model is told so, so it can decline instead of quoting lines it never saw.
 */
export const ARTIFACT_SOURCE_MAX = 120_000;
const HEAD_KEEP = 24_000;

function sourceForPrompt(code) {
  if (code.length <= ARTIFACT_SOURCE_MAX) return { source: code, truncated: false };
  const tail = ARTIFACT_SOURCE_MAX - HEAD_KEEP;
  return {
    source: `${code.slice(0, HEAD_KEEP)}\n…[middle of the document omitted — ${
      code.length - ARTIFACT_SOURCE_MAX
    } characters]…\n${code.slice(code.length - tail)}`,
    truncated: true,
  };
}

/**
 * The live artifact, appended to the user's own message.
 *
 * It rides on the user message rather than the system prompt for the same reason
 * PDF and doc text does (see pdfInjection): it is per-turn content, and the
 * message is where the model looks for what it was just asked about. Sending it
 * here also means the copies in the chat history can be summarized away, so a
 * long editing session stops re-sending the same document five times over.
 */
export function buildArtifactContext({ code, language, title, outline, rewrite = false }) {
  if (!code) return '';
  const { source, truncated } = sourceForPrompt(code);
  const lines = code.split('\n').length;
  return [
    `[Live artifact in this chat${title ? ` — "${title}"` : ''}: ${language.toUpperCase()}, ${lines} lines.`,
    // The fallback call must ask for the opposite of what the patch call asks
    // for. Leaving "do not reproduce it" in place is how a failed targeted edit
    // ends up storing edit blocks as prose, with the artifact missing entirely.
    rewrite
      ? 'A targeted edit could not be applied, so this time output the COMPLETE updated document in one code block, with the user\'s change made.]'
      : 'This is the current version. Change it with edit blocks; do not reproduce it.]',
    ...(outline ? ['', 'Outline:', outline] : []),
    '',
    'Current source:',
    source,
    ...(truncated
      ? ['', 'NOTE: the middle of the source above was omitted. If the lines you need are not shown, say so instead of guessing at them.']
      : []),
  ].join('\n');
}

/**
 * The single repair attempt, sent after the model's own failed blocks so it can
 * see what it got wrong. Worth one call: a repair costs a few hundred tokens
 * where the fallback — regenerating the document — costs thousands.
 */
export function buildRepairPrompt(detail) {
  return [
    'Those edit blocks could not be applied, so NOTHING was changed:',
    '',
    detail,
    '',
    'The current source is exactly as it was, above. Try again with corrected edit blocks:',
    '- copy the SEARCH lines character-for-character from the source, including indentation;',
    '- make sure each SEARCH appears exactly once — add a neighbouring line or two if not.',
    '',
    'Reply with the edit blocks only.',
  ].join('\n');
}
