import { useCallback, useEffect, useMemo, useState } from 'react';
import { Eye, ExternalLink, Info, Pencil, RefreshCw, Tags } from 'lucide-react';
import { useAdminStore } from '../useAdminStore.js';
import { formatPrice, fullDate, timeAgo } from '../lib/format.js';
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyRow,
  Mono,
  TableWrap,
  Td,
  Th,
} from './ui.jsx';

/**
 * The pricing tab: where a price *comes from*, and the record of every attempt.
 *
 * Prices are the one registry field that silently changes what every user is
 * billed, so nothing here writes a price. A fetch produces a proposal; the
 * proposal is reviewed in ProposalDrawer; only "Apply" touches the registry.
 */

const STATUS_TONES = {
  ready: 'accent',
  applied: 'good',
  'partially-applied': 'warn',
  failed: 'bad',
  discarded: 'neutral',
};

/** Shared fallback so a company with no models at all doesn't allocate a Set per render. */
const NO_URLS = new Set();

/** Pricing URLs are long; the host is enough to recognise one in a table. */
function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function HowItWorks() {
  return (
    <Card
      title="How pricing updates work"
      description="Three ways a price gets into the registry, from the most trustworthy to the cheapest."
    >
      <div className="space-y-3 px-5 py-4 text-sm leading-6 text-zinc-400">
        <p>
          <span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-white/[0.07] text-[11px] font-semibold text-zinc-200">
            1
          </span>
          <span className="font-medium text-zinc-200">Type it in by hand.</span> Edit a model on the
          Models tab and enter the input/output price per 1M tokens. Slowest, but you saw the number
          yourself.
        </p>
        <p>
          <span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-white/[0.07] text-[11px] font-semibold text-zinc-200">
            2
          </span>
          <span className="font-medium text-zinc-200">Let the admin LLM read the pricing page.</span>{' '}
          Point a company (or a single model) at its pricing URL and press “Fetch prices”. The server
          downloads the page, the admin LLM pulls the numbers out, and the result lands below as a
          proposal you review row by row. Nothing is written until you approve it — a wrong number
          would quietly mis-bill every user of that model. Most vendors publish one price table for
          everything they sell, so a company fetch is a single paid call. A few (Kimi, Qwen) publish
          a page per model family instead — there one company fetch reads several pages, and the
          dialog says how many and roughly what it will cost before you commit.
        </p>
        <p>
          <span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-white/[0.07] text-[11px] font-semibold text-zinc-200">
            3
          </span>
          <span className="font-medium text-zinc-200">Run “Discover models”</span> from a company’s
          key panel on the Companies tab. It just lists the model ids the provider currently serves,
          so you can spot ones that were renamed or retired. It calls no LLM and costs nothing.
        </p>
        <Callout tone="info" icon={Info}>
          The model that reads pricing pages is chosen on the <strong>Settings</strong> tab. It never
          talks to end users, so a cheap long-context model is the right pick.
        </Callout>
      </div>
    </Card>
  );
}

function PricingPagesCard() {
  const providers = useAdminStore((s) => s.providers);
  const models = useAdminStore((s) => s.models);
  // `isBusy` is a stable function, so subscribing to it alone would never
  // re-render — the `busy` map is what changes when an action starts.
  const busyMap = useAdminStore((s) => s.busy);
  const openPriceFetch = useAdminStore((s) => s.openPriceFetch);
  const openProviderEditor = useAdminStore((s) => s.openProviderEditor);

  const stats = useMemo(() => {
    const map = new Map();
    for (const model of models) {
      const entry = map.get(model.company) || {
        total: 0,
        priced: 0,
        newest: null,
        modelUrls: new Set(),
      };
      entry.total += 1;
      if (model.price?.in != null || model.price?.out != null) entry.priced += 1;
      // A Set because one page can price several models — Kimi's two K2.7 variants
      // share theirs, and that is one call, not two. Inactive models are left out
      // of the plan the server builds, so counting their pages would promise a
      // call that never runs.
      const modelUrl = model.pricingUrl?.trim();
      if (model.active && modelUrl) entry.modelUrls.add(modelUrl);
      if (
        model.priceUpdatedAt &&
        (!entry.newest || new Date(model.priceUpdatedAt) > new Date(entry.newest))
      ) {
        entry.newest = model.priceUpdatedAt;
      }
      map.set(model.company, entry);
    }
    return map;
  }, [models]);

  return (
    <Card
      title="Pricing pages"
      description="One fetch per company covers its whole price list — a single table for most vendors, a page per model for a few. Set the pricing URL first: those links are the only things the extractor is allowed to read."
    >
      <TableWrap>
        <table className="w-full min-w-[52rem] border-collapse">
          <thead>
            <tr>
              <Th>Company</Th>
              <Th>Pricing page</Th>
              <Th align="right">Models priced</Th>
              <Th>Last price change</Th>
              <Th align="right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {providers.map((provider) => {
              const { slug, pricingUrl } = provider;
              const entry =
                stats.get(slug) || { total: 0, priced: 0, newest: null, modelUrls: NO_URLS };
              const unpriced = entry.total - entry.priced;
              const modelPages = entry.modelUrls.size;
              // No company page doesn't mean no prices to read: Kimi and Qwen publish
              // one page per model, and a company fetch reads all of them.
              const canFetch = Boolean(pricingUrl) || modelPages > 0;
              return (
                <tr key={slug} className="hover:bg-white/[0.02]">
                  <Td>
                    <div className="flex items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: provider.color || '#71717a' }}
                      />
                      <span className="font-medium text-zinc-100">{provider.name}</span>
                      {!provider.active && <Badge>inactive</Badge>}
                    </div>
                  </Td>

                  <Td>
                    {pricingUrl ? (
                      <a
                        href={pricingUrl}
                        target="_blank"
                        rel="noreferrer"
                        title={pricingUrl}
                        className="inline-flex max-w-[16rem] items-center gap-1 text-xs text-indigo-300 hover:text-indigo-200"
                      >
                        <ExternalLink size={11} className="shrink-0" />
                        <span className="truncate">{hostOf(pricingUrl)}</span>
                      </a>
                    ) : modelPages ? (
                      <div className="flex items-center gap-2">
                        <Badge tone="info" title={[...entry.modelUrls].join('\n')}>
                          per model
                        </Badge>
                        <span className="text-xs text-zinc-500">
                          {modelPages} page{modelPages === 1 ? '' : 's'}
                        </span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-zinc-600">not set</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={Pencil}
                          onClick={() => openProviderEditor(provider)}
                        >
                          Edit
                        </Button>
                      </div>
                    )}
                  </Td>

                  <Td align="right" className="tabular-nums">
                    <span className="text-zinc-200">{entry.priced}</span>
                    <span className="text-zinc-600"> / {entry.total}</span>
                    {unpriced > 0 && (
                      <div className="mt-0.5 text-[11px] text-amber-400/80">
                        {unpriced} show tokens only
                      </div>
                    )}
                  </Td>

                  <Td className="whitespace-nowrap text-zinc-400">
                    <span title={fullDate(entry.newest)}>{timeAgo(entry.newest)}</span>
                  </Td>

                  <Td align="right">
                    <Button
                      size="sm"
                      icon={Tags}
                      busy={Boolean(busyMap[`price:${slug}`])}
                      disabled={!canFetch}
                      title={
                        pricingUrl
                          ? `Read ${hostOf(pricingUrl)} with the admin LLM`
                          : modelPages
                            ? `Read ${modelPages} per-model page${modelPages === 1 ? '' : 's'} with the admin LLM — the dialog confirms the count and cost first`
                            : 'Add a pricing URL to this company, or to one of its models, first'
                      }
                      onClick={() => openPriceFetch({ providerSlug: slug })}
                    >
                      Fetch prices
                    </Button>
                  </Td>
                </tr>
              );
            })}

            {!providers.length && (
              <EmptyRow colSpan={5}>No companies yet — add one on the Companies tab.</EmptyRow>
            )}
          </tbody>
        </table>
      </TableWrap>
    </Card>
  );
}

function RecentFetchesCard() {
  const proposals = useAdminStore((s) => s.proposals);
  const providers = useAdminStore((s) => s.providers);
  const busyMap = useAdminStore((s) => s.busy);
  const refreshProposals = useAdminStore((s) => s.refreshProposals);
  const openProposal = useAdminStore((s) => s.openProposal);
  const showToast = useAdminStore((s) => s.showToast);
  const [loading, setLoading] = useState(false);

  // refreshProposals is a bare fetch (not wrapped in the store's `run()`), so
  // the failure path is ours to surface.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      await refreshProposals();
    } catch (err) {
      showToast('error', err.message || 'Could not load recent fetches');
    } finally {
      setLoading(false);
    }
  }, [refreshProposals, showToast]);

  useEffect(() => {
    load();
  }, [load]);

  const nameOf = (slug) => providers.find((p) => p.slug === slug)?.name || slug;

  return (
    <Card
      title="Recent fetches"
      description={
        <>
          Every extraction run, applied or not. A discarded or failed run leaves prices untouched.
          <span className="mt-1 block">
            One row per page read, so a company whose prices span several pages adds several rows
            from a single click.
          </span>
        </>
      }
      actions={
        <Button size="sm" icon={RefreshCw} busy={loading} onClick={load}>
          Refresh
        </Button>
      }
    >
      <TableWrap>
        <table className="w-full min-w-[56rem] border-collapse">
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Company</Th>
              <Th>Scope</Th>
              <Th align="right">Rows</Th>
              <Th align="right">Cost</Th>
              <Th>Status</Th>
              <Th>Source</Th>
              <Th align="right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {proposals.map((proposal) => {
              // Summaries carry counts; a full proposal document carries items.
              const total = proposal.itemCount ?? proposal.items?.length ?? 0;
              const applied =
                proposal.appliedCount ??
                proposal.items?.filter((item) => item.applied).length ??
                0;
              return (
                <tr key={proposal._id} className="hover:bg-white/[0.02]">
                  <Td className="whitespace-nowrap text-zinc-400">
                    <span title={fullDate(proposal.createdAt)}>{timeAgo(proposal.createdAt)}</span>
                  </Td>
                  <Td className="text-zinc-200">{nameOf(proposal.providerSlug)}</Td>
                  <Td>
                    {proposal.modelSlug ? (
                      <Mono>{proposal.modelSlug}</Mono>
                    ) : (
                      <span className="text-zinc-500">whole company</span>
                    )}
                  </Td>
                  <Td align="right" className="tabular-nums">
                    {total}
                    {applied > 0 && (
                      <span className="text-emerald-400/80"> · {applied} applied</span>
                    )}
                  </Td>
                  {/* What the admin LLM charged to read this page. Shown per fetch,
                      not just in the Overview total, so the cost is attached to the
                      action that caused it. */}
                  <Td align="right" className="whitespace-nowrap tabular-nums text-zinc-400">
                    {proposal.costUsd == null ? (
                      <span className="text-zinc-600">—</span>
                    ) : (
                      <span title={`${(proposal.totalTokens ?? 0).toLocaleString()} tokens on ${proposal.adminModelId || 'the admin model'}`}>
                        {formatPrice(proposal.costUsd)}
                      </span>
                    )}
                  </Td>
                  <Td>
                    <Badge
                      tone={STATUS_TONES[proposal.status] || 'neutral'}
                      title={proposal.status === 'failed' ? proposal.error || undefined : undefined}
                    >
                      {proposal.status}
                    </Badge>
                  </Td>
                  <Td>
                    {proposal.sourceUrl ? (
                      <a
                        href={proposal.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        title={proposal.sourceUrl}
                        className="inline-flex max-w-[14rem] items-center gap-1 text-xs text-indigo-300 hover:text-indigo-200"
                      >
                        <ExternalLink size={11} className="shrink-0" />
                        <span className="truncate">{hostOf(proposal.sourceUrl)}</span>
                      </a>
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </Td>
                  <Td align="right">
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={Eye}
                      busy={Boolean(busyMap[`proposal:${proposal._id}`])}
                      onClick={() => openProposal(proposal._id)}
                    >
                      Review
                    </Button>
                  </Td>
                </tr>
              );
            })}

            {!proposals.length && (
              <EmptyRow colSpan={7}>
                No price fetches yet. Pick a company above and press “Fetch prices”.
              </EmptyRow>
            )}
          </tbody>
        </table>
      </TableWrap>
    </Card>
  );
}

export default function PricingPanel() {
  return (
    <div className="space-y-5">
      <HowItWorks />
      <PricingPagesCard />
      <RecentFetchesCard />
    </div>
  );
}
