import { getCompany, isCompanyAvailable } from '../config/registry.js';
import * as openai from './openai.js';
import * as anthropic from './anthropic.js';
import * as google from './google.js';
import * as demo from './demo.js';

/**
 * Routes a chat request to the right provider adapter. Every adapter shares
 * the same streamChat signature, so the rest of the app never cares which
 * company a model belongs to.
 */
export async function streamChat({ model, messages, system, signal, onToken }) {
  const company = getCompany(model.company);
  if (!company) throw new Error(`Unknown company: ${model.company}`);

  if (!isCompanyAvailable(company)) {
    throw new Error(
      `${company.name} is not configured. Add ${company.envKey} to server/.env and restart the server.`
    );
  }

  const common = { apiModel: model.apiModel, messages, system, signal, onToken };

  switch (model.company) {
    case 'openai':
      return openai.streamChat({ ...common, apiKey: process.env.OPENAI_API_KEY });
    case 'anthropic':
      return anthropic.streamChat({ ...common, apiKey: process.env.ANTHROPIC_API_KEY });
    case 'google':
      return google.streamChat({ ...common, apiKey: process.env.GOOGLE_API_KEY });
    case 'moonshot':
      // Moonshot exposes an OpenAI-compatible API.
      return openai.streamChat({
        ...common,
        apiKey: process.env.MOONSHOT_API_KEY,
        baseURL: process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.ai/v1',
      });
    case 'deepseek':
      // DeepSeek exposes an OpenAI-compatible API (thinking mode is server-side default).
      return openai.streamChat({
        ...common,
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      });
    case 'mistral':
      // Mistral exposes an OpenAI-compatible API. Use versions copied from their model cards (url).
      return openai.streamChat({
        ...common,
        apiKey: process.env.MISTRAL_API_KEY,
        baseURL: process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1',
      });
    case 'zai':
      // Z.ai (GLM) exposes an OpenAI-compatible API.
      return openai.streamChat({
        ...common,
        apiKey: process.env.ZAI_API_KEY,
        baseURL: process.env.ZAI_BASE_URL || 'https://api.z.ai/api/paas/v4',
      });
    case 'demo':
      return demo.streamChat(common);
    default:
      throw new Error(`No provider adapter for company: ${model.company}`);
  }
}

/**
 * Image-understanding step for the two-model setup: when the chat model can't
 * see images, a vision-capable model describes them and its description is
 * injected into the (text-only) chat model's prompt. The vision model is used
 * ONLY for this — never for the conversational reply.
 */
export async function describeImages({ visionModel, images, question, signal }) {
  const prompt = [
    'You are the image-understanding step in a two-model setup. The user attached image(s) to a chat whose main model cannot see images.',
    'Describe the image(s) thoroughly and objectively: visible text (quote it exactly), UI elements, diagrams, charts and their data, code, people, objects, layout, colors.',
    question
      ? `The user's message about the image(s): "${question}" — make sure your description covers what they asked, and answer it directly if possible.`
      : 'The user gave no instructions, so produce a complete general description.',
    'Output plain descriptive text only — it will be handed to the text model as context.',
  ].join('\n');

  const { content, usage } = await streamChat({
    model: visionModel,
    messages: [{ role: 'user', content: prompt, images }],
    system: null,
    signal,
    onToken: () => {},
  });
  return { description: content, usage };
}
