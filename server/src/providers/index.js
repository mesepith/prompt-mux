import {
  getCompany,
  isCompanyAvailable,
  resolveApiKey,
  resolveBaseURL,
} from '../config/registry.js';
import * as openai from './openai.js';
import * as anthropic from './anthropic.js';
import * as google from './google.js';
import * as demo from './demo.js';

/**
 * Routes a chat request to the right provider adapter. Every adapter shares
 * the same streamChat signature, so the rest of the app never cares which
 * company a model belongs to.
 *
 * Routing is keyed on the company's `adapter` (not its id), because companies
 * are rows in MongoDB now: an admin can add a brand-new vendor from the
 * dashboard with adapter 'openai' + its baseURL and it works with no code
 * change. Almost every vendor ships an OpenAI-compatible endpoint.
 *
 * The API key and base URL come from the registry (DB value first, env var as
 * the fallback) — never from process.env directly, or a key entered in the
 * dashboard would be silently ignored.
 */
export async function streamChat({ model, messages, system, signal, onToken, maxTokens }) {
  const company = getCompany(model.company);
  if (!company) throw new Error(`Unknown company: ${model.company}`);

  // An admin can switch a company or a model off while conversations still
  // reference it. Say so plainly instead of failing at the provider.
  if (!company.active) {
    throw new Error(`${company.name} has been deactivated by the administrator.`);
  }
  if (model.active === false) {
    throw new Error(`${model.name} has been deactivated by the administrator.`);
  }

  if (!isCompanyAvailable(company)) {
    throw new Error(
      `${company.name} has no API key. Add one in the admin dashboard${
        company.envKey ? `, or set ${company.envKey} in server/.env and restart the server` : ''
      }.`
    );
  }

  const apiKey = resolveApiKey(company);
  const baseURL = resolveBaseURL(company);
  const common = { apiModel: model.apiModel, messages, system, signal, onToken, ...(maxTokens ? { maxTokens } : {}) };

  switch (company.adapter) {
    case 'openai':
      return openai.streamChat({ ...common, apiKey, ...(baseURL ? { baseURL } : {}) });
    case 'anthropic':
      return anthropic.streamChat({ ...common, apiKey, ...(baseURL ? { baseURL } : {}) });
    case 'google':
      // The Google SDK takes no base URL override.
      return google.streamChat({ ...common, apiKey });
    case 'demo':
      return demo.streamChat(common);
    default:
      throw new Error(
        `No provider adapter for "${company.adapter}" (company: ${company.id}). Use openai, anthropic, google or demo.`
      );
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
