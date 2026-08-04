import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, History } from 'lucide-react';
import { useAdminStore } from '../useAdminStore.js';
import {
  Badge,
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
import { formatPricePair, fullDate, timeAgo, toSlug } from '../lib/format.js';

/**
 * Create/edit form for one model. Two fields are deliberately immutable once
 * saved: `slug`, because conversations and messages store it as their model id,
 * and `company`, because the company decides which adapter and API key the
 * request is routed through — moving a model across companies would silently
 * send its `apiModel` to a provider that has never heard of it.
 */

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_PRICE = 100000;

function toFormState(model, isNew) {
  return {
    company: model.company || '',
    name: model.name || '',
    slug: model.slug || '',
    apiModel: model.apiModel || '',
    tagline: model.tagline || '',
    priceIn: model.price?.in ?? null,
    priceOut: model.price?.out ?? null,
    priceCachedIn: model.price?.cachedIn ?? null,
    currency: model.currency || 'USD',
    contextWindow: model.contextWindow ?? null,
    maxOutput: model.maxOutput ?? null,
    pricingUrl: model.pricingUrl || '',
    notes: model.notes || '',
    vision: Boolean(model.vision),
    pdf: Boolean(model.pdf),
    active: isNew ? true : Boolean(model.active),
    sortOrder: model.sortOrder ?? null,
  };
}

function validatePrice(value) {
  if (value === null) return null;
  if (!Number.isFinite(value)) return 'Enter a number, or leave it empty for “unknown”.';
  if (value < 0) return 'A price can’t be negative.';
  if (value > MAX_PRICE) return `That looks wrong — the cap is ${MAX_PRICE} per 1M tokens.`;
  return null;
}

function validateCount(value, label) {
  if (value === null) return null;
  if (!Number.isInteger(value) || value <= 0) return `${label} must be a whole number above zero.`;
  return null;
}

function validate(form) {
  const errors = {};
  if (!form.company) errors.company = 'Pick the company this model belongs to.';
  if (!form.name.trim()) errors.name = 'Give the model a display name.';

  const slug = form.slug.trim();
  if (!slug) errors.slug = 'An id is required — it is what conversations store.';
  else if (!SLUG_RE.test(slug))
    errors.slug = 'Lowercase letters, digits, dot, dash and underscore only; must start with a letter or digit.';

  if (!form.apiModel.trim()) errors.apiModel = 'Required — this is what gets sent to the provider.';

  const priceIn = validatePrice(form.priceIn);
  if (priceIn) errors.priceIn = priceIn;
  const priceOut = validatePrice(form.priceOut);
  if (priceOut) errors.priceOut = priceOut;
  const priceCachedIn = validatePrice(form.priceCachedIn);
  if (priceCachedIn) errors.priceCachedIn = priceCachedIn;

  const context = validateCount(form.contextWindow, 'Context window');
  if (context) errors.contextWindow = context;
  const maxOutput = validateCount(form.maxOutput, 'Max output');
  if (maxOutput) errors.maxOutput = maxOutput;

  return errors;
}

function PriceHistory({ entries }) {
  const [open, setOpen] = useState(false);
  const sorted = useMemo(
    () => [...entries].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()),
    [entries]
  );

  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-xs font-medium text-zinc-300"
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <History size={13} className="text-zinc-500" />
        Price history
        <span className="text-zinc-500">({sorted.length})</span>
      </button>
      {open && (
        <ul className="space-y-2 border-t border-white/[0.06] px-4 py-3">
          {sorted.map((entry, index) => (
            <li key={entry.at ? `${entry.at}-${index}` : index} className="text-xs text-zinc-400">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={entry.source === 'fetched' ? 'good' : 'neutral'}>
                  {entry.source || 'seed'}
                </Badge>
                <span className="tabular-nums text-zinc-200">
                  {formatPricePair({ in: entry.in, out: entry.out })}
                </span>
                <span className="text-zinc-500" title={fullDate(entry.at)}>
                  {timeAgo(entry.at)}
                </span>
              </div>
              {entry.note && <div className="mt-1 leading-4 text-zinc-500">{entry.note}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function ModelEditor() {
  const editing = useAdminStore((s) => s.editingModel);
  const providers = useAdminStore((s) => s.providers);
  const closeModelEditor = useAdminStore((s) => s.closeModelEditor);
  const createModel = useAdminStore((s) => s.createModel);
  const updateModel = useAdminStore((s) => s.updateModel);
  // Subscribe to the busy map itself: the store's `isBusy` helper keeps the same
  // identity forever, so selecting it alone would never repaint the Save spinner.
  const busyMap = useAdminStore((s) => s.busy);
  const isBusy = (key) => Boolean(busyMap[key]);

  const original = editing || {};
  const isNew = Boolean(original.isNew);

  const [form, setForm] = useState(() => toFormState(original, isNew));
  // Stop deriving the id from the name once a human has typed one.
  const [slugEdited, setSlugEdited] = useState(false);
  const [errors, setErrors] = useState({});

  const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const companyOptions = useMemo(
    () =>
      [...providers]
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name))
        .map((p) => ({ value: p.slug, label: p.active ? p.name : `${p.name} (inactive)` })),
    [providers]
  );

  const company = providers.find((p) => p.slug === form.company) || null;
  const busy = isNew ? isBusy('model:create') : isBusy(`model:${original.slug}`);
  const unpriced = form.priceIn === null && form.priceOut === null;

  const onNameChange = (value) => {
    setForm((prev) => ({
      ...prev,
      name: value,
      slug: isNew && !slugEdited ? toSlug(value) : prev.slug,
    }));
  };

  const buildPrice = () => ({
    in: form.priceIn,
    out: form.priceOut,
    cachedIn: form.priceCachedIn,
  });

  const hasAnyPrice =
    form.priceIn !== null || form.priceOut !== null || form.priceCachedIn !== null;

  /** Only changed keys go to PATCH, so two admins editing different fields don't clobber each other. */
  const buildPatch = () => {
    const patch = {};
    const scalars = {
      name: form.name.trim(),
      apiModel: form.apiModel.trim(),
      tagline: form.tagline.trim(),
      currency: form.currency.trim() || 'USD',
      contextWindow: form.contextWindow,
      maxOutput: form.maxOutput,
      pricingUrl: form.pricingUrl.trim(),
      notes: form.notes.trim(),
      vision: form.vision,
      pdf: form.pdf,
      active: form.active,
      sortOrder: form.sortOrder,
    };
    for (const [key, value] of Object.entries(scalars)) {
      const before = original[key] ?? (typeof value === 'string' ? '' : null);
      if (value !== before) patch[key] = value;
    }
    const price = original.price || {};
    if (
      (price.in ?? null) !== form.priceIn ||
      (price.out ?? null) !== form.priceOut ||
      (price.cachedIn ?? null) !== form.priceCachedIn
    ) {
      patch.price = buildPrice();
    }
    return patch;
  };

  const submit = async () => {
    const found = validate(form);
    setErrors(found);
    if (Object.keys(found).length) return;

    if (isNew) {
      const res = await createModel({
        slug: form.slug.trim(),
        company: form.company,
        name: form.name.trim(),
        apiModel: form.apiModel.trim(),
        tagline: form.tagline.trim(),
        // An all-empty price means "unknown", which is the absence of the field.
        ...(hasAnyPrice ? { price: buildPrice() } : {}),
        currency: form.currency.trim() || 'USD',
        contextWindow: form.contextWindow,
        maxOutput: form.maxOutput,
        pricingUrl: form.pricingUrl.trim(),
        notes: form.notes.trim(),
        vision: form.vision,
        pdf: form.pdf,
        active: form.active,
        sortOrder: form.sortOrder,
      });
      if (res.ok) closeModelEditor();
      return;
    }

    const patch = buildPatch();
    if (!Object.keys(patch).length) {
      closeModelEditor();
      return;
    }
    const res = await updateModel(original.slug, patch);
    if (res.ok) closeModelEditor();
  };

  return (
    <Modal
      wide
      title={isNew ? 'Add a model' : `Edit ${original.name}`}
      description={
        isNew
          ? 'The id is what conversations store; the API model is what the provider receives.'
          : 'Changes apply to every user as soon as you save.'
      }
      onClose={closeModelEditor}
      footer={
        <>
          <Button variant="ghost" onClick={closeModelEditor}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} onClick={submit}>
            {isNew ? 'Add model' : 'Save changes'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {isNew ? (
            <Field label="Company" required error={errors.company}>
              <Select
                value={form.company}
                onChange={(value) => set('company', value)}
                options={companyOptions}
                placeholder="Select a company"
              />
            </Field>
          ) : (
            <Field
              label="Company"
              hint="Fixed after creation — the company picks the adapter and API key this model is called with."
            >
              <div className="flex items-center gap-2 py-2">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: company?.color || original.companyColor || '#71717a' }}
                />
                <span className="text-sm text-zinc-200">
                  {company?.name || original.companyName || original.company}
                </span>
                <Mono>{original.company}</Mono>
              </div>
            </Field>
          )}

          <Field label="Name" required error={errors.name} hint="Shown in the model picker.">
            <TextInput value={form.name} onChange={onNameChange} placeholder="Claude Opus 4.6" autoFocus />
          </Field>

          {isNew ? (
            <Field
              label="Id"
              required
              error={errors.slug}
              hint="Derived from the name until you edit it. Stored on every message — pick it carefully."
            >
              <TextInput
                mono
                value={form.slug}
                onChange={(value) => {
                  setSlugEdited(true);
                  set('slug', value);
                }}
                placeholder="claude-opus-4-6"
              />
            </Field>
          ) : (
            <Field label="Id" hint="Read-only: existing conversations reference this model by its id.">
              <div className="py-2">
                <Mono>{original.slug}</Mono>
              </div>
            </Field>
          )}

          <Field
            label="API model"
            required
            error={errors.apiModel}
            hint="The exact id the provider's API expects. “Discover models” on the company's key panel lists the valid ones."
          >
            <TextInput
              mono
              value={form.apiModel}
              onChange={(value) => set('apiModel', value)}
              placeholder="claude-opus-4-6-20260501"
            />
          </Field>
        </div>

        <Field label="Tagline" hint="One short line under the name in the picker.">
          <TextInput
            value={form.tagline}
            onChange={(value) => set('tagline', value)}
            placeholder="Best for long reasoning tasks"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Input price / 1M tokens" error={errors.priceIn}>
            <NumberInput
              value={form.priceIn}
              step={0.01}
              onChange={(value) => set('priceIn', value)}
              placeholder="unknown"
            />
          </Field>
          <Field label="Output price / 1M tokens" error={errors.priceOut}>
            <NumberInput
              value={form.priceOut}
              step={0.01}
              onChange={(value) => set('priceOut', value)}
              placeholder="unknown"
            />
          </Field>
          <Field
            label="Cached input / 1M"
            error={errors.priceCachedIn}
            hint="Optional, for providers that bill cache reads separately."
          >
            <NumberInput
              value={form.priceCachedIn}
              step={0.01}
              onChange={(value) => set('priceCachedIn', value)}
              placeholder="optional"
            />
          </Field>
        </div>

        {unpriced && (
          <Callout tone="warn">
            Leaving both prices empty hides cost estimates for this model — chats will show token
            counts only.
          </Callout>
        )}

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Currency" hint="Prices are stored per 1M tokens.">
            <TextInput value={form.currency} onChange={(value) => set('currency', value)} placeholder="USD" />
          </Field>
          <Field label="Context window" error={errors.contextWindow} hint="Total tokens in, e.g. 200000.">
            <NumberInput
              value={form.contextWindow}
              step={1}
              onChange={(value) => set('contextWindow', value)}
              placeholder="200000"
            />
          </Field>
          <Field label="Max output" error={errors.maxOutput} hint="Tokens the model can return in one reply.">
            <NumberInput
              value={form.maxOutput}
              step={1}
              onChange={(value) => set('maxOutput', value)}
              placeholder="64000"
            />
          </Field>
        </div>

        <Field
          label="Pricing page"
          hint="Overrides the company's pricing page when fetching prices for this model."
        >
          <TextInput
            value={form.pricingUrl}
            onChange={(value) => set('pricingUrl', value)}
            placeholder="https://…/pricing"
          />
        </Field>

        <Field label="Notes" hint="Internal only — never shown to chat users.">
          <TextArea value={form.notes} onChange={(value) => set('notes', value)} rows={2} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Checkbox
              checked={form.vision}
              onChange={(value) => set('vision', value)}
              label="Accepts images"
            />
            <p className="mt-1 text-[11px] leading-4 text-zinc-500">
              When off, uploaded images are routed to a separate vision model and only its
              description reaches this one.
            </p>
          </div>
          <div>
            <Checkbox
              checked={form.pdf}
              onChange={(value) => set('pdf', value)}
              label="Accepts native PDFs"
            />
            <p className="mt-1 text-[11px] leading-4 text-zinc-500">
              PDF text is extracted server-side either way; this marks providers that take the file
              itself.
            </p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Checkbox
              checked={form.active}
              onChange={(value) => set('active', value)}
              label="Active"
            />
            <p className="mt-1 text-[11px] leading-4 text-zinc-500">
              Inactive models disappear from the picker; past conversations keep working.
            </p>
          </div>
          <Field label="Sort order" hint="Lower numbers come first inside the company.">
            <NumberInput
              value={form.sortOrder}
              step={1}
              min={-999}
              onChange={(value) => set('sortOrder', value)}
              placeholder="0"
            />
          </Field>
        </div>

        {!isNew && original.priceHistory?.length > 0 && (
          <PriceHistory entries={original.priceHistory} />
        )}
      </div>
    </Modal>
  );
}
