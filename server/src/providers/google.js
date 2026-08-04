import { GoogleGenerativeAI } from '@google/generative-ai';
import { parseDataUrl } from '../lib/images.js';

// Gemini format: "model" for the assistant role; images are inlineData parts.
function toGeminiParts(m) {
  const parts = [];
  if (m.content) parts.push({ text: m.content });
  for (const url of m.images || []) {
    const { mimeType, base64 } = parseDataUrl(url);
    parts.push({ inlineData: { mimeType, data: base64 } });
  }
  return parts.length ? parts : [{ text: '' }];
}

/**
 * How long to wait for the next chunk before giving up on a stream.
 *
 * The deprecated @google/generative-ai SDK's async iterator sometimes stalls
 * forever on Gemini 3.x streams: no chunk, no throw, no completion. Because
 * nothing throws, the messages route never reaches `finishWith`, so no done or
 * error frame is sent and the user watches a spinner until nginx times out at
 * 600s. Racing each `next()` against a timer turns that into a normal error the
 * transcript can show. Generous on purpose — a slow first token on a long prompt
 * is legitimate, a two-minute silence is not.
 */
const STREAM_IDLE_TIMEOUT_MS = Number(process.env.GOOGLE_STREAM_IDLE_TIMEOUT_MS) || 120_000;

/**
 * Wraps an async iterator so a gap longer than `timeoutMs` between values
 * rejects instead of hanging. Only the *gap* is bounded, not the total duration,
 * so a long but healthy stream is never cut off.
 */
async function* withIdleTimeout(iterator, timeoutMs, label) {
  const source = iterator[Symbol.asyncIterator]();
  for (;;) {
    let timer;
    const stall = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} stopped sending data for ${Math.round(timeoutMs / 1000)}s — the stream stalled. Try again, or pick a different model.`)),
        timeoutMs
      );
    });
    let step;
    try {
      step = await Promise.race([source.next(), stall]);
    } finally {
      clearTimeout(timer);
    }
    if (step.done) return;
    yield step.value;
  }
}

export async function streamChat({ apiKey, apiModel, messages, system, signal, onToken, maxTokens }) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: apiModel,
    ...(system ? { systemInstruction: system } : {}),
    ...(maxTokens ? { generationConfig: { maxOutputTokens: maxTokens } } : {}),
  });

  // History must start with a user turn.
  const mapped = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: toGeminiParts(m),
  }));
  while (mapped.length && mapped[0].role !== 'user') mapped.shift();

  const last = mapped.pop();
  const chat = model.startChat({ history: mapped });
  const textPart = last.parts.find((p) => p.text)?.text || '';
  // sendMessageStream accepts full parts arrays (text + inlineData)
  const result = await chat.sendMessageStream(last.parts.length > 1 ? last.parts : textPart);

  let content = '';
  let usage = null;
  for await (const chunk of withIdleTimeout(result.stream, STREAM_IDLE_TIMEOUT_MS, apiModel)) {
    if (signal?.aborted) break;
    const meta = chunk.usageMetadata;
    if (meta) {
      usage = {
        inputTokens: meta.promptTokenCount ?? 0,
        outputTokens: meta.candidatesTokenCount ?? 0,
        totalTokens: meta.totalTokenCount ?? 0,
        reasoningTokens: meta.thoughtsTokenCount ?? 0,
      };
    }
    const text = chunk.text();
    if (text) {
      content += text;
      onToken(text);
    }
  }
  return { content, usage };
}
