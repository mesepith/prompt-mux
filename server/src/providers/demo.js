/**
 * Offline demo provider — no API key required. Streams a canned reply that
 * includes a self-contained HTML artifact so you can test streaming and the
 * artifact panel end-to-end before adding real provider keys.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEMO_REPLY = `Here's a quick demo of what PromptMux artifacts look like — an interactive glow card, generated as a self-contained HTML artifact. Click the **preview** on the right!

\`\`\`html
<!-- title: Interactive Glow Card -->
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Interactive Glow Card</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    min-height: 100vh; display: grid; place-items: center;
    background: radial-gradient(ellipse at top, #1e1b4b, #09090b 70%);
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    overflow: hidden;
  }
  .card {
    position: relative; width: min(420px, 90vw); padding: 40px 32px;
    border-radius: 24px; background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08);
    backdrop-filter: blur(12px); text-align: center; color: #fafafa;
    transition: transform .15s ease-out;
  }
  .card::before {
    content: ''; position: absolute; inset: -1px; border-radius: 24px;
    background: radial-gradient(320px circle at var(--mx, 50%) var(--my, 50%),
      rgba(139,92,246,0.35), transparent 60%);
    z-index: -1; transition: opacity .3s;
  }
  h1 {
    font-size: 28px; font-weight: 800; letter-spacing: -0.02em;
    background: linear-gradient(90deg, #a78bfa, #818cf8, #38bdf8);
    -webkit-background-clip: text; background-clip: text; color: transparent;
    margin-bottom: 12px;
  }
  p { color: #a1a1aa; line-height: 1.6; margin-bottom: 24px; }
  button {
    padding: 12px 28px; border: none; border-radius: 999px; cursor: pointer;
    font-weight: 600; font-size: 15px; color: white;
    background: linear-gradient(90deg, #8b5cf6, #6366f1);
    box-shadow: 0 8px 24px rgba(139,92,246,0.4);
    transition: transform .15s, box-shadow .15s;
  }
  button:hover { transform: translateY(-2px); box-shadow: 0 12px 32px rgba(139,92,246,0.55); }
  button:active { transform: translateY(0); }
  #count { color: #c4b5fd; font-weight: 700; }
</style>
</head>
<body>
  <div class="card" id="card">
    <h1>PromptMux Artifact</h1>
    <p>This HTML is being rendered live in a sandboxed panel — streamed from the demo model. Move your mouse over the card and click the button.</p>
    <button id="btn">Clicked <span id="count">0</span> times</button>
  </div>
<script>
  const card = document.getElementById('card');
  card.addEventListener('mousemove', (e) => {
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', (e.clientX - r.left) + 'px');
    card.style.setProperty('--my', (e.clientY - r.top) + 'px');
  });
  let n = 0;
  document.getElementById('btn').addEventListener('click', () => {
    document.getElementById('count').textContent = ++n;
  });
</script>
</body>
</html>
\`\`\`

Some things you can ask any connected model:

- **"Build me a tic-tac-toe game"** — playable artifact
- **"Make a landing page for a coffee brand"** — full page artifact
- **"Explain transformers like I'm five"** — plain markdown answer

> **Tip:** switch models mid-conversation with the picker in the composer — each reply shows which model wrote it.`;

const VISION_REPLY = `**Demo Vision analysis** (offline placeholder — a real vision model would describe the actual pixels):

- The attached image was received and decoded successfully.
- Layout, colors, text and objects would be described here in detail.
- Any question about the image would be answered directly.

> Configure a real vision model (e.g. GLM-4.6V-Flash, Gemini Flash, Kimi K3) in the image slot to get genuine image understanding.`;

/**
 * Offline stand-in for a chat-driven artifact edit.
 *
 * When the chat has a live artifact, the route injects its source into the user
 * message and asks for SEARCH/REPLACE blocks (config/patchPrompt.js). There is no
 * model here, so this makes a deterministic, clearly-labelled edit instead —
 * enough to exercise parse → locate → splice → store → re-render with no keys,
 * exactly like `editFragment` does for point-and-edit.
 *
 * Two escape hatches make the failure paths testable too, since they are the
 * ones that are otherwise impossible to reach on purpose:
 *   "demo:badpatch" in the message -> quote code that isn't there (repair, then
 *                                     the full-rewrite fallback)
 *   "demo:repair"   in the message -> miss once, then get it right on the repair
 */
function demoPatchReply(messages) {
  const users = messages.filter((m) => m.role === 'user').map((m) => String(m.content || ''));
  // The source rides on the message that asked for the change — which on a repair
  // call is no longer the last one, since the repair prompt comes after it.
  const text = [...users].reverse().find((m) => m.includes('Current source:')) || '';
  const at = text.indexOf('Current source:');
  if (at === -1) return null;
  const source = text.slice(at + 'Current source:'.length).trim();
  if (!source) return null;
  const lastUser = users[users.length - 1] || '';

  // A real model decides from the prompt whether the user wants a change or an
  // answer. The demo has to fake that judgement, or an offline test of "what does
  // this do?" would come back as an edit and misrepresent the feature.
  const asked = text.slice(0, at).trim();
  if (/\?\s*$/.test(asked) || /^(what|why|how|when|where|which|who|is|are|does|do|can|could|should)\b/i.test(asked))
    return null;

  // The fallback call asks for the whole document instead — hand back the canned
  // artifact so the offline test exercises a genuine rewrite, not another patch.
  if (/output the COMPLETE updated document/i.test(text)) return null;

  const isRepair = /could not be applied/i.test(lastUser);
  const wantsFailure = /demo:badpatch/i.test(text) || (/demo:repair/i.test(text) && !isRepair);
  if (wantsFailure) {
    return [
      'Editing that for you.',
      '',
      '```patch',
      '<<<<<<< SEARCH',
      '  /* a line the demo provider knows is not in this document */',
      '=======',
      '  /* replaced */',
      '>>>>>>> REPLACE',
      '```',
    ].join('\n');
  }

  // Any anchor will do as long as it is genuinely unique — the server refuses
  // ambiguous matches, and a demo that trips that guard would just look broken.
  const anchor = ['</style>', '</body>', '</html>'].find((candidate) => {
    const first = source.indexOf(candidate);
    return first !== -1 && source.indexOf(candidate, first + 1) === -1;
  });
  if (!anchor) return null;

  return [
    'Applied a targeted edit (demo provider — a real model would make the change you asked for).',
    '',
    '```patch',
    '<<<<<<< SEARCH',
    anchor,
    '=======',
    '  /* demo targeted edit — only these lines were touched */',
    '  html { outline: 3px dashed #8b5cf6; outline-offset: -6px; }',
    anchor,
    '>>>>>>> REPLACE',
    '```',
  ].join('\n');
}

export async function streamChat({ apiModel, messages = [], signal, onToken }) {
  const isVision = apiModel === 'demo-vision';
  const patch = isVision ? null : demoPatchReply(messages);
  const reply = isVision ? VISION_REPLY : patch || DEMO_REPLY;

  let content = '';
  // Stream word-by-word with small delays to simulate a real model.
  const chunks = reply.split(/(?<=\s)/);
  for (const chunk of chunks) {
    if (signal?.aborted) break;
    content += chunk;
    onToken(chunk);
    await sleep(12);
  }
  // Rough estimate (~4 chars/token) so the UI can demo usage/cost display offline.
  const estimate = (text) => Math.max(1, Math.ceil(text.length / 4));
  const imageCount = messages.reduce((n, m) => n + (m.images?.length || 0), 0);
  const inputTokens = estimate(messages.map((m) => m.content).join('\n')) + imageCount * 500;
  const outputTokens = estimate(content);
  return {
    content,
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
  };
}

/**
 * Offline stand-in for a point-and-edit request. There is no model behind the
 * demo provider, so instead of inventing markup it makes a deterministic,
 * clearly-labelled change to the selected fragment: a dashed violet outline
 * plus the instruction recorded on the element. That's enough to exercise the
 * whole select → edit → splice → re-render path with no API keys.
 */
export async function editFragment({ snippet, instruction }) {
  await sleep(250);
  const openEnd = openTagEnd(snippet);
  if (openEnd === -1) return { content: snippet, usage: null };

  const openTag = snippet.slice(0, openEnd);
  const note = String(instruction || '')
    .slice(0, 120)
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const demoStyle = 'outline:3px dashed #8b5cf6;outline-offset:3px';

  // Merge into an existing style attribute — a duplicate one would be ignored.
  const styleMatch = openTag.match(/(\sstyle\s*=\s*)(["'])([\s\S]*?)\2/i);
  let patched;
  if (styleMatch) {
    const merged = `${styleMatch[1]}${styleMatch[2]}${styleMatch[3].replace(/;?\s*$/, '')};${demoStyle}${styleMatch[2]}`;
    patched = openTag.replace(styleMatch[0], merged);
  } else {
    const selfClosing = /\/>$/.test(openTag);
    patched = `${openTag.slice(0, selfClosing ? -2 : -1)} style="${demoStyle}"${selfClosing ? '/>' : '>'}`;
  }
  patched = patched.replace(/(\s*\/?>)$/, ` data-demo-edit="${note}"$1`);
  return { content: patched + snippet.slice(openEnd), usage: null };
}

/** Index just past the fragment's first ">" , skipping quoted attributes. */
function openTagEnd(fragment) {
  if (!fragment.startsWith('<')) return -1;
  for (let i = 1; i < fragment.length; i++) {
    const ch = fragment[i];
    if (ch === '"' || ch === "'") {
      const q = fragment.indexOf(ch, i + 1);
      if (q === -1) return -1;
      i = q;
      continue;
    }
    if (ch === '>') return i + 1;
  }
  return -1;
}
