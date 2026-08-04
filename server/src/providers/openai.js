import OpenAI from 'openai';

/**
 * Unified streaming interface. All providers implement:
 *   streamChat({ apiKey, baseURL?, apiModel, messages, system, signal, onToken })
 *     -> Promise<{ content, usage }>
 * messages = [{ role: 'user'|'assistant', content, images?: [dataUrl] }]
 * onToken(delta) is called for every streamed chunk.
 */

// OpenAI format: text-only messages stay plain strings; messages with images
// become content-part arrays with image_url parts (data URLs are accepted).
function toOpenAIMessage(m) {
  if (!m.images?.length) return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: [
      { type: 'text', text: m.content || '' },
      ...m.images.map((url) => ({ type: 'image_url', image_url: { url } })),
    ],
  };
}

export async function streamChat({ apiKey, baseURL, apiModel, messages, system, signal, onToken, maxTokens }) {
  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const stream = await client.chat.completions.create(
    {
      model: apiModel,
      stream: true,
      // Only set when a caller needs a hard cap (the dashboard's key test asks for
      // a single token). Left unset for chat so each model uses its own default.
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      // Ask OpenAI-compatible APIs to include a usage object in the final chunk.
      stream_options: { include_usage: true },
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...messages.map(toOpenAIMessage),
      ],
    },
    { signal }
  );

  let content = '';
  let usage = null;
  for await (const chunk of stream) {
    if (chunk.usage) {
      usage = {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
        totalTokens: chunk.usage.total_tokens ?? 0,
        reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0,
      };
    }
    const delta = chunk.choices?.[0]?.delta?.content || '';
    if (delta) {
      content += delta;
      onToken(delta);
    }
  }
  return { content, usage };
}
