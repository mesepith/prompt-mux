import Anthropic from '@anthropic-ai/sdk';
import { parseDataUrl } from '../lib/images.js';

const CACHE = { cache_control: { type: 'ephemeral' } };

// Anthropic format: image blocks with base64 sources, then the text block.
//
// `m.cacheBoundary` marks the end of the reusable prefix (see the caller). Unlike
// every OpenAI-compatible vendor, Anthropic caches nothing unless asked, so this
// marker is the whole difference between paying full price for a growing chat
// history every turn and paying ~10% for the part already sent. Content blocks
// are the only place the flag can go, so a plain string message is promoted to a
// one-block array when it carries the boundary.
export function toAnthropicMessage(m) {
  if (!m.images?.length) {
    return m.cacheBoundary
      ? { role: m.role, content: [{ type: 'text', text: m.content || '', ...CACHE }] }
      : { role: m.role, content: m.content };
  }
  return {
    role: m.role,
    content: [
      ...m.images.map((url) => {
        const { mimeType, base64 } = parseDataUrl(url);
        return { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } };
      }),
      { type: 'text', text: m.content || '', ...(m.cacheBoundary ? CACHE : {}) },
    ],
  };
}

export async function streamChat({ apiKey, baseURL, apiModel, messages, system, signal, onToken, maxTokens }) {
  // baseURL lets an admin point this adapter at an Anthropic-compatible gateway
  // (added from the dashboard as a new company) without a code change.
  const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const stream = await client.messages.create(
    {
      model: apiModel,
      max_tokens: maxTokens || 8192,
      ...(system ? { system } : {}),
      messages: messages.map(toAnthropicMessage),
      stream: true,
    },
    { signal }
  );

  let content = '';
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  for await (const event of stream) {
    if (event.type === 'message_start') {
      const u = event.message?.usage || {};
      // Anthropic's input_tokens EXCLUDES cached ones, unlike everyone else's
      // prompt_tokens. Add them back so inputTokens always means "the size of the
      // prompt" and cachedInputTokens is a subset of it — otherwise a cache hit
      // would look like the prompt had shrunk.
      const read = u.cache_read_input_tokens ?? 0;
      const written = u.cache_creation_input_tokens ?? 0;
      cachedInputTokens = read;
      inputTokens = (u.input_tokens ?? 0) + read + written;
    } else if (event.type === 'message_delta') {
      // output_tokens is cumulative across message_delta events
      outputTokens = event.usage?.output_tokens ?? outputTokens;
    } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      content += event.delta.text;
      onToken(event.delta.text);
    }
  }
  const usage =
    inputTokens || outputTokens
      ? { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cachedInputTokens }
      : null;
  return { content, usage };
}
