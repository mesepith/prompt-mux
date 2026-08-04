import { useState } from 'react';
import { useAdminStore } from '../useAdminStore.js';
import { toSlug } from '../lib/format.js';
import {
  Button,
  Callout,
  Checkbox,
  Field,
  Modal,
  Mono,
  NumberInput,
  Select,
  TextArea,
  TextInput,
} from './ui.jsx';

/**
 * Create / edit one LLM company. Everything is a plain local draft: the store
 * only hears about it on Save, so a half-typed base URL never reaches the
 * registry that every user's model picker reads.
 */

const ADAPTERS = [
  { value: 'openai', label: 'openai — OpenAI-compatible /v1/chat/completions' },
  { value: 'anthropic', label: 'anthropic — Anthropic Messages API' },
  { value: 'google', label: 'google — Gemini API' },
  { value: 'demo', label: 'demo — offline stand-in, no key or network' },
];

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HEX_RE = /^#[0-9a-f]{6}$/i;

/** Empty is fine (every URL here is optional); anything else must be http(s). */
function urlProblem(value, label) {
  if (!value) return null;
  try {
    const { protocol } = new URL(value);
    if (protocol !== 'http:' && protocol !== 'https:') return `${label} must start with https://`;
    return null;
  } catch {
    return `${label} is not a valid URL`;
  }
}

function validate(draft) {
  const errors = {};
  if (!draft.name.trim()) errors.name = 'A display name is required';
  if (!draft.slug.trim()) errors.slug = 'An id is required';
  else if (!SLUG_RE.test(draft.slug.trim()))
    errors.slug = 'Lower-case letters, digits, dot, dash and underscore only';
  if (!HEX_RE.test(draft.color)) errors.color = 'Use a 6-digit hex colour like #6366f1';
  errors.baseURL = urlProblem(draft.baseURL.trim(), 'The base URL');
  errors.pricingUrl = urlProblem(draft.pricingUrl.trim(), 'The pricing URL');
  errors.docsUrl = urlProblem(draft.docsUrl.trim(), 'The docs URL');
  for (const key of Object.keys(errors)) if (!errors[key]) delete errors[key];
  return errors;
}

const TEXT_FIELDS = ['name', 'baseURL', 'envKey', 'baseUrlEnv', 'pricingUrl', 'docsUrl', 'notes'];

export default function ProviderEditor() {
  const provider = useAdminStore((s) => s.editingProvider);
  const busyMap = useAdminStore((s) => s.busy);
  const closeProviderEditor = useAdminStore((s) => s.closeProviderEditor);
  const createProvider = useAdminStore((s) => s.createProvider);
  const updateProvider = useAdminStore((s) => s.updateProvider);

  const isNew = Boolean(provider?.isNew) || !provider?.slug;

  const [draft, setDraft] = useState(() => ({
    name: provider?.name || '',
    slug: provider?.slug || '',
    adapter: provider?.adapter || 'openai',
    baseURL: provider?.baseURL || '',
    envKey: provider?.envKey || '',
    baseUrlEnv: provider?.baseUrlEnv || '',
    color: provider?.color || '#6366f1',
    pricingUrl: provider?.pricingUrl || '',
    docsUrl: provider?.docsUrl || '',
    notes: provider?.notes || '',
    requiresKey: provider?.requiresKey !== false,
    active: provider?.active !== false,
    sortOrder: provider?.sortOrder ?? null,
    apiKey: '',
  }));
  // The slug follows the name until the admin types their own — after that the
  // two are independent, or renaming a company would rewrite its id.
  const [slugPinned, setSlugPinned] = useState(!isNew);
  const [submitted, setSubmitted] = useState(false);

  const saving = Boolean(busyMap[isNew ? 'provider:create' : `provider:${provider.slug}`]);
  const errors = submitted ? validate(draft) : {};

  const set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));

  const setName = (name) => {
    setDraft((d) => ({ ...d, name, slug: slugPinned ? d.slug : toSlug(name) }));
  };

  const setSlug = (slug) => {
    setSlugPinned(true);
    set('slug', slug.toLowerCase());
  };

  const submit = async () => {
    setSubmitted(true);
    if (Object.keys(validate(draft)).length) return;

    const body = {
      name: draft.name.trim(),
      adapter: draft.adapter,
      baseURL: draft.baseURL.trim(),
      envKey: draft.envKey.trim(),
      baseUrlEnv: draft.baseUrlEnv.trim(),
      color: draft.color,
      pricingUrl: draft.pricingUrl.trim(),
      docsUrl: draft.docsUrl.trim(),
      notes: draft.notes.trim(),
      requiresKey: draft.requiresKey,
      active: draft.active,
      ...(typeof draft.sortOrder === 'number' ? { sortOrder: draft.sortOrder } : {}),
    };

    let res;
    if (isNew) {
      const apiKey = draft.apiKey.trim();
      res = await createProvider({
        ...body,
        slug: draft.slug.trim(),
        ...(apiKey ? { apiKey } : {}),
      });
    } else {
      // PATCH only what moved, so two admins editing different fields of the
      // same company don't overwrite each other.
      const patch = {};
      for (const key of Object.keys(body)) {
        const current = TEXT_FIELDS.includes(key) ? provider[key] || '' : provider[key];
        if (body[key] !== current) patch[key] = body[key];
      }
      if (!Object.keys(patch).length) {
        closeProviderEditor();
        return;
      }
      res = await updateProvider(provider.slug, patch);
    }
    if (res.ok) closeProviderEditor();
  };

  return (
    <Modal
      title={isNew ? 'Add an LLM company' : `Edit ${provider.name}`}
      description="A company owns the adapter, the base URL and the API key; its models inherit all three."
      onClose={closeProviderEditor}
      footer={
        <>
          <Button variant="ghost" onClick={closeProviderEditor}>
            Cancel
          </Button>
          <Button variant="primary" busy={saving} onClick={submit}>
            {isNew ? 'Add company' : 'Save changes'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Display name" required error={errors.name} hint="Shown in the model picker.">
          <TextInput value={draft.name} onChange={setName} placeholder="Moonshot AI" autoFocus disabled={saving} />
        </Field>

        {isNew ? (
          <Field
            label="Id (slug)"
            required
            error={errors.slug}
            hint="Permanent — models and conversations reference it."
          >
            <TextInput value={draft.slug} onChange={setSlug} placeholder="moonshot" mono disabled={saving} />
          </Field>
        ) : (
          <Field label="Id (slug)" hint="Cannot change: existing models and conversations reference it.">
            <div className="py-2">
              <Mono>{provider.slug}</Mono>
            </div>
          </Field>
        )}

        <Field
          label="Adapter"
          hint="Most vendors speak the OpenAI protocol — for a new company, “openai” plus a base URL is usually right."
        >
          <Select
            value={draft.adapter}
            onChange={(value) => set('adapter', value)}
            options={ADAPTERS}
            disabled={saving}
          />
        </Field>

        <Field
          label="Base URL"
          error={errors.baseURL}
          hint="Leave empty for the adapter's own default endpoint."
        >
          <TextInput
            value={draft.baseURL}
            onChange={(value) => set('baseURL', value)}
            placeholder="https://api.moonshot.ai/v1"
            mono
            disabled={saving}
          />
        </Field>

        <Field
          label="Key env var (legacy fallback — leave empty)"
          hint="Paste API keys with the Key button on the Companies tab; that is the normal way and it always wins. This field only names an environment variable to fall back on, which exists so deployments that had keys in server/.env before this dashboard existed keep working. Blank is correct for a new company."
        >
          <TextInput
            value={draft.envKey}
            onChange={(value) => set('envKey', value)}
            placeholder="(none)"
            mono
            disabled={saving}
          />
        </Field>

        <Field
          label="Base URL env var"
          hint="Optional override, for pointing one company at a proxy per deployment."
        >
          <TextInput
            value={draft.baseUrlEnv}
            onChange={(value) => set('baseUrlEnv', value)}
            placeholder="MOONSHOT_BASE_URL"
            mono
            disabled={saving}
          />
        </Field>

        <Field label="Colour" error={errors.color} hint="The dot next to every model of this company.">
          <div className="flex items-center gap-2">
            <div className="w-14 shrink-0">
              <TextInput
                type="color"
                value={draft.color}
                onChange={(value) => set('color', value)}
                disabled={saving}
              />
            </div>
            <TextInput
              value={draft.color}
              onChange={(value) => set('color', value)}
              placeholder="#6366f1"
              mono
              disabled={saving}
            />
          </div>
        </Field>

        <Field label="Sort order" hint="Lower comes first in the picker. Empty keeps the default.">
          <NumberInput
            value={draft.sortOrder}
            onChange={(value) => set('sortOrder', value)}
            placeholder="100"
            step={1}
            disabled={saving}
          />
        </Field>

        <Field label="Pricing page" error={errors.pricingUrl} hint="Where the price fetcher reads from.">
          <TextInput
            value={draft.pricingUrl}
            onChange={(value) => set('pricingUrl', value)}
            placeholder="https://platform.moonshot.ai/pricing"
            disabled={saving}
          />
        </Field>

        <Field label="Docs" error={errors.docsUrl}>
          <TextInput
            value={draft.docsUrl}
            onChange={(value) => set('docsUrl', value)}
            placeholder="https://platform.moonshot.ai/docs"
            disabled={saving}
          />
        </Field>

        <Field label="Notes" className="sm:col-span-2" hint="Admin-only. Quirks, billing state, rate limits.">
          <TextArea
            value={draft.notes}
            onChange={(value) => set('notes', value)}
            placeholder="Billing suspended since June — models kept inactive."
            disabled={saving}
          />
        </Field>

        <div className="flex flex-wrap items-center gap-6 sm:col-span-2">
          <Checkbox
            checked={draft.requiresKey}
            onChange={(value) => set('requiresKey', value)}
            disabled={saving}
            label="Needs an API key"
          />
          <Checkbox
            checked={draft.active}
            onChange={(value) => set('active', value)}
            disabled={saving}
            label="Active (visible to every user)"
          />
        </div>

        {isNew && (
          <Field
            label="API key (optional)"
            className="sm:col-span-2"
            hint="Encrypted before it is stored and never sent back to the browser. You can also add it later."
          >
            <TextInput
              type="password"
              value={draft.apiKey}
              onChange={(value) => set('apiKey', value)}
              placeholder="sk-…"
              disabled={saving}
            />
          </Field>
        )}
      </div>

      {!isNew && provider.modelCount > 0 && (
        <div className="mt-4">
          <Callout tone="warn">
            {provider.modelCount} model(s) belong to {provider.name}. Changing the adapter or base URL
            changes how every one of them is called.
          </Callout>
        </div>
      )}
    </Modal>
  );
}
