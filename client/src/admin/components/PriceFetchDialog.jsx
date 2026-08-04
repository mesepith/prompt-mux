import { useMemo, useState } from 'react';
import { ExternalLink, Info, Sparkles, Tags } from 'lucide-react';
import { useAdminStore } from '../useAdminStore.js';
import { formatPricePair } from '../lib/format.js';
import {
  Badge,
  Button,
  Callout,
  Field,
  Modal,
  Mono,
  Select,
  TextInput,
} from './ui.jsx';

/**
 * Confirms one price fetch before it runs.
 *
 * The dialog exists because the action isn't free or purely local: the server
 * downloads a third-party page and pays an LLM to read it. So it spells out
 * exactly which URL will be fetched, which model will read it, and what happens
 * to the result — a proposal, not a write.
 */

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export default function PriceFetchDialog() {
  const target = useAdminStore((s) => s.priceFetchTarget);
  const providers = useAdminStore((s) => s.providers);
  const models = useAdminStore((s) => s.models);
  const settings = useAdminStore((s) => s.settings);
  const candidates = useAdminStore((s) => s.adminModelCandidates);
  const busyMap = useAdminStore((s) => s.busy);
  const fetchPrices = useAdminStore((s) => s.fetchPrices);
  const closePriceFetch = useAdminStore((s) => s.closePriceFetch);

  const { providerSlug, modelSlug } = target || {};
  const provider = providers.find((p) => p.slug === providerSlug) || null;
  const model = modelSlug ? models.find((m) => m.slug === modelSlug) || null : null;

  const [url, setUrl] = useState(
    () => target?.url || model?.pricingUrl || provider?.pricingUrl || ''
  );
  const [error, setError] = useState(null);
  // Only used when Settings has no admin model yet — otherwise the setting wins.
  const [pickedModelId, setPickedModelId] = useState('');

  const configuredId = settings?.adminModelId || '';
  const effectiveId = configuredId || pickedModelId;
  const configuredModel = configuredId ? models.find((m) => m.slug === configuredId) || null : null;

  const candidateOptions = useMemo(
    () =>
      candidates.map((c) => ({
        value: c.id,
        label: `${c.companyName || c.company} — ${c.name}${c.available ? '' : ' (no key)'}`,
      })),
    [candidates]
  );

  const busy = Boolean(busyMap[`price:${modelSlug || providerSlug}`]);
  const autoApply = settings?.requireApproval === false;
  const noCandidates = !configuredId && candidateOptions.length === 0;

  const submit = async () => {
    const trimmed = url.trim();
    if (!trimmed) {
      setError('Enter the pricing page URL to read.');
      return;
    }
    if (!isHttpUrl(trimmed)) {
      setError('Must be a full http:// or https:// URL.');
      return;
    }
    setError(null);
    const res = await fetchPrices({
      providerSlug,
      modelSlug,
      url: trimmed,
      // Sent explicitly so the run is pinned to the model shown here, even if
      // someone changes the setting while the fetch is in flight.
      adminModelId: effectiveId || undefined,
    });
    // The store puts the resulting proposal in `activeProposal`; the review
    // drawer takes over from here.
    if (res.ok) closePriceFetch();
  };

  return (
    <Modal
      title={model ? `Fetch prices for ${model.name}` : `Fetch prices for ${provider?.name || providerSlug}`}
      description="Reads a pricing page with the admin LLM and turns it into a proposal you review."
      onClose={closePriceFetch}
      footer={
        <>
          <Button variant="ghost" onClick={closePriceFetch}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={Tags}
            busy={busy}
            disabled={noCandidates || (!configuredId && !pickedModelId)}
            onClick={submit}
          >
            Fetch prices
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3 text-xs leading-5 text-zinc-400">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: provider?.color || '#71717a' }}
            />
            <span className="text-sm font-medium text-zinc-100">
              {provider?.name || providerSlug}
            </span>
            {model ? (
              <>
                <Badge tone="accent">one model</Badge>
                <Mono>{model.slug}</Mono>
                <span className="text-zinc-500">now {formatPricePair(model.price)} per 1M</span>
              </>
            ) : (
              <Badge tone="accent">every model of this company</Badge>
            )}
          </div>
        </div>

        <Field
          label="Pricing page to read"
          required
          error={error}
          hint="Whatever this page says is what the extractor will propose — link the official price table, not a blog post."
        >
          <TextInput
            value={url}
            onChange={(value) => {
              setUrl(value);
              setError(null);
            }}
            mono
            autoFocus
            placeholder="https://example.com/pricing"
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
        </Field>

        {isHttpUrl(url.trim()) && (
          <a
            href={url.trim()}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-indigo-300 hover:text-indigo-200"
          >
            <ExternalLink size={11} />
            Open the page yourself first
          </a>
        )}

        {configuredId ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
            <Sparkles size={13} className="text-indigo-300" />
            Read by
            <span className="text-zinc-200">{configuredModel?.name || configuredId}</span>
            <Mono>{configuredId}</Mono>
            <span className="text-zinc-500">— change it on the Settings tab.</span>
          </div>
        ) : (
          <>
            <Field
              label="Which model should read the page"
              required
              hint="Saved settings have no admin model yet, so pick one for this run."
            >
              <Select
                value={pickedModelId}
                onChange={setPickedModelId}
                options={candidateOptions}
                placeholder={
                  candidateOptions.length ? 'Choose a model…' : 'No model can be used yet'
                }
                disabled={!candidateOptions.length}
              />
            </Field>
            <Callout tone="warn">
              {noCandidates
                ? 'No company has a working API key, so nothing can read the page. Add a key on the Companies tab first.'
                : 'Choose the model that will read the page. Set a default on the Settings tab so you don’t have to pick every time.'}
            </Callout>
          </>
        )}

        <Callout tone="info" icon={Info}>
          The server downloads this page (your browser never touches it) and sends the text to the
          admin model, which costs a small number of tokens — a few cents at most on a cheap model.
        </Callout>

        {autoApply ? (
          <Callout tone="warn">
            <strong>Auto-apply is ON.</strong> “Require approval” is turned off in Settings, so rows
            the extractor is confident about will be written to the registry immediately — including
            wrong ones. Every user’s cost figures change with them. Turn approval back on unless you
            have a reason not to.
          </Callout>
        ) : (
          <p className="text-xs leading-5 text-zinc-500">
            Nothing is written yet. The result opens as a proposal and only the rows you tick get
            saved.
          </p>
        )}
      </div>
    </Modal>
  );
}
