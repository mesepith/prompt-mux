/**
 * Server-side artifact helpers. An artifact is a fenced ```html / ```svg block
 * in an assistant message. Point-and-edit needs to find the exact same block
 * the client is previewing, so this fence regex MUST stay in sync with
 * client/src/lib/artifacts.js#extractArtifacts.
 */
const FENCE_RE = /```(html|svg)\s*\n([\s\S]*?)(?:```|$)/g;

/**
 * Below this, a fenced block is a snippet rather than an artifact and is skipped
 * (the client applies the same threshold). Exported because anything that WRITES
 * an artifact has to respect it: storing a fence this side of the line produces a
 * message that looks like it has an artifact and has none.
 */
export const MIN_ARTIFACT_CHARS = 30;

export function extractArtifacts(content) {
  const artifacts = [];
  if (!content) return artifacts;
  const re = new RegExp(FENCE_RE.source, 'g');
  let match;
  while ((match = re.exec(content)) !== null) {
    const code = match[2].trim();
    if (code.length < MIN_ARTIFACT_CHARS) continue; // same threshold as the client
    artifacts.push({ language: match[1], code, index: artifacts.length });
  }
  return artifacts;
}

export function artifactFence(language, code) {
  return `\`\`\`${language}\n${code}\n\`\`\``;
}

/**
 * Human label for an artifact — the <title> of a published page and the name in
 * the share dialog. Same rules as `deriveTitle` in client/src/lib/artifacts.js
 * so a published artifact isn't called something else than the panel calls it.
 */
export function deriveTitle(language, code) {
  const comment = code.match(/<!--\s*title:\s*(.+?)\s*-->/);
  if (comment) return comment[1].slice(0, 120);
  const titleTag = code.match(/<title>([^<]*)<\/title>/i);
  if (titleTag && titleTag[1].trim()) return titleTag[1].trim().slice(0, 120);
  return language === 'svg' ? 'vector.svg' : 'index.html';
}

/**
 * Strips the artifact code out of a message for provider history: after a few
 * edits the same document would otherwise be repeated in full in every turn's
 * context. Measured on a real 618-line game, five chat-driven fixes meant five
 * full copies — ~25k input tokens of the same document.
 *
 * `note` says where the live version actually is, because that differs by
 * caller: the chat route injects the current source once alongside the newest
 * message and summarizes every copy including the newest, while the plain
 * history path keeps the newest copy and only trims what it superseded.
 */
export function summarizeArtifactFences(content, note = 'superseded by a later version in this chat') {
  if (!content) return content;
  return content.replace(
    new RegExp(FENCE_RE.source, 'g'),
    (_full, language, code) => `[${language} artifact, ${code.trim().length} chars — ${note}]`
  );
}
