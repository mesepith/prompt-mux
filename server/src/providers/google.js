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

export async function streamChat({ apiKey, apiModel, messages, system, signal, onToken }) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: apiModel,
    ...(system ? { systemInstruction: system } : {}),
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
  for await (const chunk of result.stream) {
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
