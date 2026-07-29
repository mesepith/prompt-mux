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

export async function streamChat({ apiModel, messages = [], signal, onToken }) {
  const isVision = apiModel === 'demo-vision';
  const reply = isVision ? VISION_REPLY : DEMO_REPLY;

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
