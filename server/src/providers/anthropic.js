import Anthropic from '@anthropic-ai/sdk';
import { parseDataUrl } from '../lib/images.js';

// Anthropic format: image blocks with base64 sources, then the text block.
function toAnthropicMessage(m) {
  if (!m.images?.length) return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: [
      ...m.images.map((url) => {
        const { mimeType, base64 } = parseDataUrl(url);
        return { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } };
      }),
      { type: 'text', text: m.content || '' },
    ],
  };
}

export async function streamChat({ apiKey, apiModel, messages, system, signal, onToken }) {
  const client = new Anthropic({ apiKey });
  const stream = await client.messages.create(
    {
      model: apiModel,
      max_tokens: 8192,
      ...(system ? { system } : {}),
      messages: messages.map(toAnthropicMessage),
      stream: true,
    },
    { signal }
  );

  let content = '';
  let inputTokens = 0;
  let outputTokens = 0;
  for await (const event of stream) {
    if (event.type === 'message_start') {
      inputTokens = event.message?.usage?.input_tokens ?? 0;
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
      ? { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
      : null;
  return { content, usage };
}
