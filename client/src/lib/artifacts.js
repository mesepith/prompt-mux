/**
 * Artifact helpers. An "artifact" is a fenced ```html or ```svg block in an
 * assistant message; the UI renders it live in a sandboxed preview panel
 * (Claude-Artifacts style).
 */
export function extractArtifacts(content) {
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

/** Builds the full document loaded into the sandboxed preview iframe. */
export function buildPreviewDoc(artifact) {
  if (!artifact) return '';
  if (artifact.language === 'svg') {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #fff; }
  svg { max-width: 96vw; max-height: 96vh; }
</style></head><body>${artifact.code}</body></html>`;
  }
  if (/^\s*(<!DOCTYPE|<html)/i.test(artifact.code)) return artifact.code;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 16px; }</style>
</head><body>${artifact.code}</body></html>`;
}

export function openArtifactInNewTab(artifact) {
  const blob = new Blob([buildPreviewDoc(artifact)], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
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
