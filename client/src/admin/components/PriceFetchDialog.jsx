import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Info, Layers, Sparkles, Tags } from 'lucide-react';
import { useAdminStore } from '../useAdminStore.js';
import { formatPrice, formatPricePair } from '../lib/format.js';
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  Field,
  Modal,
  Mono,
  Select,
  Spinner,
  TableWrap,
  Td,
  TextInput,
  Th,
} from './ui.jsx';

/**
 * Confirms a price fetch before it runs.
 *
 * The dialog exists because the action isn't free or purely local: the server
 * downloads a third-party page and pays an LLM to read it. So it spells out
 * exactly which URL will be fetched, which model will read it, and what happens
 * to the result — a proposal, not a write.
 *
 * A company-level fetch is not always one page: most vendors publish a single
 * price table, but Kimi and Qwen publish one per model or family, so pricing that
 * company means several paid calls. The plan endpoint costs nothing, so the page
 * count and the money are on screen before the button can be pressed.
 */

const NAMES_SHOWN = 6;

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function nameList(names) {
  const list = names || [];
  if (list.length <= NAMES_SHOWN) return list.join(', ');
  return `${list.slice(0, NAMES_SHOWN).join(', ')} +${list.length - NAMES_SHOWN} more`;
}

/**
 * `https://platform.kimi.ai/docs/pricing/chat-k27-code.md`
 *   -> `platform.kimi.ai/…/chat-k27-code.md`
 *
 * The distinguishing part of a pricing URL is its last segment, so plain CSS
 * truncation (which eats the tail) makes a list of sibling pages unreadable.
 */
function shortenUrl(url, max = 44) {
  let host = url;
  let path = '';
  try {
    const parsed = new URL(url);
    host = parsed.host.replace(/^www\./, '');
    path = parsed.pathname.replace(/\/$/, '');
  } catch {
    return url.length > max ? `${url.slice(0, max - 1)}…` : url;
  }
  const last = path.split('/').filter(Boolean).pop() || '';
  const full = `${host}${path}`;
  if (full.length <= max) return full;
  return last ? `${host}/…/${last}` : `${host}…`;
}

function pagesLabel(n) {
  return `${n} page${n === 1 ? '' : 's'}`;
}

export default function PriceFetchDialog() {
  const target = useAdminStore((s) => s.priceFetchTarget);
  const providers = useAdminStore((s) => s.providers);
  const models = useAdminStore((s) => s.models);
  const settings = useAdminStore((s) => s.settings);
  const candidates = useAdminStore((s) => s.adminModelCandidates);
  const busyMap = useAdminStore((s) => s.busy);
  const plan = useAdminStore((s) => s.fetchPlan);
  const fetchPrices = useAdminStore((s) => s.fetchPrices);
  const fetchPricesBatch = useAdminStore((s) => s.fetchPricesBatch);
  const loadFetchPlan = useAdminStore((s) => s.loadFetchPlan);
  const closePriceFetch = useAdminStore((s) => s.closePriceFetch);

  const { providerSlug, modelSlug } = target || {};
  const provider = providers.find((p) => p.slug === providerSlug) || null;
  const model = modelSlug ? models.find((m) => m.slug === modelSlug) || null : null;
  // One model is one page by definition; only a company-level fetch can span pages.
  const companyFetch = !modelSlug;

  const [url, setUrl] = useState(
    () => target?.url || model?.pricingUrl || provider?.pricingUrl || ''
  );
  const [error, setError] = useState(null);
  // Only used when Settings has no admin model yet — otherwise the setting wins.
  const [pickedModelId, setPickedModelId] = useState('');
  const [selectedUrls, setSelectedUrls] = useState([]);
  const [planFailed, setPlanFailed] = useState(false);

  // Free — this calls no model — so the plan can be loaded on mount and the cost
  // shown before anything is spent.
  useEffect(() => {
    if (!companyFetch || !providerSlug) return undefined;
    let alive = true;
    loadFetchPlan(providerSlug).then((res) => {
      // The store raises its own error toast; this only stops the spinner from
      // becoming a dead end.
      if (alive && !res) setPlanFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [companyFetch, providerSlug, loadFetchPlan]);

  const planReady = companyFetch && plan?.providerSlug === providerSlug;
  const calls = planReady ? plan.calls || [] : [];
  const multiPage = calls.length > 1;
  const singleCall = calls.length === 1 ? calls[0] : null;

  // Every page starts ticked: the plan is what pricing this company takes, and
  // dropping one is the exception.
  useEffect(() => {
    if (!plan || plan.providerSlug !== providerSlug) {
      setSelectedUrls([]);
      return;
    }
    setSelectedUrls((plan.calls || []).map((c) => c.url));
  }, [plan, providerSlug]);

  // With no company-wide price table there is no URL to prefill until the plan
  // lands, so it arrives late. An already-filled field wins — it may be the
  // caller's override, or something typed while the plan was loading.
  useEffect(() => {
    if (singleCall) setUrl((prev) => prev || singleCall.url);
  }, [singleCall]);

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

  // Settings has no default, but the server would fall back to some keyed model
  // anyway. Preselecting the one it named keeps the estimate and the actual bill
  // the same number.
  const planAdminId = planReady ? plan.adminModel?.id || null : null;
  useEffect(() => {
    if (configuredId || !planAdminId) return;
    if (!candidates.some((c) => c.id === planAdminId)) return;
    setPickedModelId((prev) => prev || planAdminId);
  }, [configuredId, planAdminId, candidates]);

  // Both paths share one busy key; the batch uses the company form of it.
  const busy = Boolean(busyMap[`price:${modelSlug || providerSlug}`]);
  const autoApply = settings?.requireApproval === false;
  const noCandidates = !configuredId && candidateOptions.length === 0;

  const adminModelError = planReady ? plan.adminModelError : null;
  const loadingPlan = companyFetch && !planReady && !planFailed;
  const noPages = planReady && plan.mode === 'none';
  // Nothing can read a page without a usable admin model, and mode 'none' has no
  // page to read, so neither offers a fetch.
  const canFetch = !loadingPlan && !noPages && !adminModelError;

  const providerName =
    provider?.name || (planReady ? plan.companyName : null) || providerSlug || 'this company';
  // Whichever model will actually be billed — the configured default, or the one
  // picked here when none is set.
  const chosenModel = useMemo(() => {
    const found = effectiveId ? models.find((m) => m.slug === effectiveId) : null;
    if (found) return found;
    return candidates.find((c) => c.id === effectiveId) || null;
  }, [effectiveId, models, candidates]);

  // A rough band, not a promise: a typical pricing page runs 1.5k-6k tokens in and
  // a few hundred out. Showing it beside the model's own rate turns "a small number
  // of tokens" into a number the reader can actually judge. Priced per page so the
  // total tracks the pages still ticked.
  const perPage = useMemo(() => {
    const price = chosenModel?.price;
    if (price && typeof price.in === 'number' && typeof price.out === 'number') {
      return {
        low: (1500 * price.in + 200 * price.out) / 1e6,
        high: (6000 * price.in + 800 * price.out) / 1e6,
      };
    }
    // The chosen model carries no local price — divide the server's own estimate
    // for the whole plan back out to one page.
    const est = planReady ? plan.estimate : null;
    if (est?.calls && est.lowUsd != null && est.highUsd != null) {
      return { low: est.lowUsd / est.calls, high: est.highUsd / est.calls };
    }
    return null;
  }, [chosenModel, planReady, plan]);

  const costRange = (count) =>
    perPage && count ? `${formatPrice(perPage.low * count)}–${formatPrice(perPage.high * count)}` : null;
  const selectedCost = costRange(selectedUrls.length);
  const onePageCost = costRange(1);

  const allSelected = multiPage && selectedUrls.length === calls.length;
  const toggleAll = () => setSelectedUrls(allSelected ? [] : calls.map((c) => c.url));
  const toggleUrl = (value) =>
    setSelectedUrls((prev) =>
      prev.includes(value) ? prev.filter((u) => u !== value) : [...prev, value]
    );

  const coverage = useMemo(() => {
    if (!planReady || !singleCall) return null;
    const names = singleCall.modelNames || [];
    if (!names.length) {
      return `${providerName} has no active models, so a proposal from this page would have nothing to update.`;
    }
    if (plan.mode === 'company') {
      return `This one page carries the prices for all ${names.length} active model(s) of ${providerName} — ${nameList(names)}.`;
    }
    return `${providerName} prices per model page, and this is the only one — it covers ${nameList(names)}.`;
  }, [planReady, singleCall, plan, providerName]);

  const submitOne = async () => {
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

  const submitBatch = async () => {
    if (!selectedUrls.length) return;
    const res = await fetchPricesBatch({
      providerSlug,
      adminModelId: effectiveId || undefined,
      urls: selectedUrls,
    });
    // One proposal per page came back; the store opened the first and toasted the
    // summary itself.
    if (res.ok) closePriceFetch();
  };

  return (
    <Modal
      title={model ? `Fetch prices for ${model.name}` : `Fetch prices for ${providerName}`}
      description="Reads a pricing page with the admin LLM and turns it into a proposal you review."
      onClose={closePriceFetch}
      footer={
        <>
          <Button variant="ghost" onClick={closePriceFetch}>
            Cancel
          </Button>
          {canFetch &&
            (multiPage ? (
              <Button
                variant="primary"
                icon={Tags}
                busy={busy}
                disabled={noCandidates || !effectiveId || !selectedUrls.length}
                onClick={submitBatch}
              >
                {`Fetch ${pagesLabel(selectedUrls.length)}`}
              </Button>
            ) : (
              <Button
                variant="primary"
                icon={Tags}
                busy={busy}
                disabled={noCandidates || !effectiveId}
                onClick={submitOne}
              >
                Fetch prices
              </Button>
            ))}
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
            <span className="text-sm font-medium text-zinc-100">{providerName}</span>
            {model ? (
              <>
                <Badge tone="accent">one model</Badge>
                <Mono>{model.slug}</Mono>
                <span className="text-zinc-500">now {formatPricePair(model.price)} per 1M</span>
              </>
            ) : (
              <>
                <Badge tone="accent">every model of this company</Badge>
                {multiPage && <Badge tone="info">{pagesLabel(calls.length)}</Badge>}
              </>
            )}
          </div>
        </div>

        {loadingPlan ? (
          <Spinner label="Working out which pages hold this company’s prices…" />
        ) : (
          <>
            {planFailed && (
              <Callout tone="warn">
                Couldn’t work out which pages {providerName} spreads its prices over. You can still
                read a single page below — the Models tab fetches the rest one at a time.
              </Callout>
            )}

            {adminModelError ? (
              <Callout tone="bad">
                {adminModelError} Nothing can read a pricing page until an admin model is usable, so
                there is nothing to fetch yet.
              </Callout>
            ) : noPages ? (
              <Callout tone="warn">
                Neither {providerName} nor any of its models has a pricing URL, so there is no page
                to read. Set one for the whole company on the <span className="font-medium">Companies</span>{' '}
                tab, or — if this vendor publishes a page per model, as Kimi and Qwen do — one per
                model on the <span className="font-medium">Models</span> tab.
              </Callout>
            ) : multiPage ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 rounded-xl border border-indigo-500/25 bg-indigo-500/[0.07] px-4 py-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
                    <Layers size={14} className="shrink-0 text-indigo-300" />
                    <span className="tabular-nums">{pagesLabel(selectedUrls.length)}</span>
                    <span className="text-zinc-600">·</span>
                    <span className="tabular-nums">
                      {!selectedUrls.length
                        ? 'nothing to read'
                        : selectedCost
                          ? `about ${selectedCost}`
                          : 'cost unknown'}
                    </span>
                  </div>
                  <span className="text-[11px] leading-4 text-zinc-400">
                    one paid call per page, read one after another
                  </span>
                </div>

                <p className="text-xs leading-5 text-zinc-500">
                  {providerName} publishes prices per model, so pricing the company takes several
                  pages. Untick any you don’t need — each one you drop is one call you don’t pay for.
                </p>

                <div className="overflow-hidden rounded-xl border border-white/[0.07]">
                  <TableWrap>
                    <table className="w-full">
                      <thead>
                        <tr>
                          <Th className="w-10">
                            <span title={allSelected ? 'Untick every page' : 'Tick every page'}>
                              <Checkbox checked={allSelected} onChange={toggleAll} />
                            </span>
                          </Th>
                          <Th>Page</Th>
                          <Th>Prices these models</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {calls.map((call) => (
                          <tr key={call.url}>
                            <Td className="align-top">
                              <Checkbox
                                checked={selectedUrls.includes(call.url)}
                                onChange={() => toggleUrl(call.url)}
                              />
                            </Td>
                            <Td className="align-top">
                              {/* Middle-truncated, not tail-truncated: these URLs differ
                                  only in their LAST segment (chat-k3 vs chat-k27-code), so
                                  clipping the end renders every row identical. */}
                              <span
                                className="block max-w-[17rem] font-mono text-[12px] text-zinc-300"
                                title={call.url}
                              >
                                {shortenUrl(call.url)}
                              </span>
                              <a
                                href={call.url}
                                target="_blank"
                                rel="noreferrer"
                                className="mt-1 inline-flex items-center gap-1 text-[11px] text-indigo-300 hover:text-indigo-200"
                              >
                                <ExternalLink size={10} />
                                open
                              </a>
                            </Td>
                            <Td className="align-top text-xs text-zinc-400">
                              {call.modelNames?.length ? nameList(call.modelNames) : '—'}
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                </div>
              </div>
            ) : (
              <>
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
                      if (e.key === 'Enter') submitOne();
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

                {coverage && <p className="text-xs leading-5 text-zinc-500">{coverage}</p>}
              </>
            )}

            {planReady && plan.uncovered?.length > 0 && (
              <p className="text-xs leading-5 text-zinc-500">
                No pricing URL for {nameList(plan.uncovered.map((m) => m.name))} — this run won’t
                price {plan.uncovered.length === 1 ? 'it' : 'them'}.
              </p>
            )}

            {planReady && plan.dropped > 0 && (
              <Callout tone="warn">
                {pagesLabel(plan.dropped)} of {providerName}’s prices are left out of this run: one
                click reads at most {plan.maxCalls}. Fetch the rest a model at a time from the{' '}
                <span className="font-medium">Models</span> tab.
              </Callout>
            )}

            {!adminModelError &&
              (configuredId ? (
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
              ))}

            <Callout tone="info" icon={Info}>
              The server downloads {multiPage ? 'these pages' : 'this page'} (your browser never
              touches {multiPage ? 'them' : 'it'}) and sends the text to the admin model. Each page is
              a real billed call, and it is charged to{' '}
              <span className="font-medium">
                {chosenModel?.companyName || 'the admin model’s company'}
              </span>{' '}
              — not to {providerName}. The bill scales with the size of the page, typically
              1,500–6,000 tokens per page
              {onePageCost ? `, about ${onePageCost} at this model’s rate` : ''}. Every fetch is
              recorded with its tokens and cost under{' '}
              <span className="font-medium">Overview → Admin operations</span>.
            </Callout>

            {autoApply ? (
              <Callout tone="warn">
                <strong>Auto-apply is ON.</strong> “Require approval” is turned off in Settings, so
                rows the extractor is confident about will be written to the registry immediately —
                including wrong ones. Every user’s cost figures change with them. Turn approval back
                on unless you have a reason not to.
              </Callout>
            ) : (
              <p className="text-xs leading-5 text-zinc-500">
                Nothing is written yet. {multiPage ? 'Each page opens as its own proposal' : 'The result opens as a proposal'}{' '}
                and only the rows you tick get saved.
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
