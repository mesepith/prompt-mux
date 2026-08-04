import { useState } from 'react';
import { Check, ExternalLink, Info, Sparkles } from 'lucide-react';
import clsx from 'clsx';
import { useAdminStore } from '../useAdminStore.js';
import { formatPrice, fullDate, priceDelta, timeAgo } from '../lib/format.js';
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  ConfirmInline,
  EmptyRow,
  Modal,
  Mono,
  TableWrap,
  Td,
  Th,
} from './ui.jsx';

/**
 * Review-and-apply for one price proposal: the human gate between "an LLM read a
 * web page" and "every user's cost figures changed".
 *
 * Only ticked rows are written, and the pre-ticked set is deliberately narrow —
 * a row is only checked by default when it maps to a registry model, carries a
 * price, and actually differs from what's stored. Everything else (unmatched
 * labels, no-op rows, already-applied rows) has to be ticked on purpose.
 */

const EVIDENCE_MAX_CHARS = 90;

function hasProposedPrice(item) {
  return item.inPrice != null || item.outPrice != null || item.cachedInPrice != null;
}

/**
 * True when applying the row would change nothing. `cachedIn` has no registry
 * snapshot on the item, so a row that only brings a cached price can never be
 * proven unchanged — it stays a real change.
 */
function isNoChange(item) {
  if (!hasProposedPrice(item)) return false;
  const same = (next, current) => next == null || (current != null && Number(next) === Number(current));
  return (
    item.cachedInPrice == null &&
    same(item.inPrice, item.currentIn) &&
    same(item.outPrice, item.currentOut)
  );
}

function isApplicable(item) {
  return Boolean(item.modelSlug) && hasProposedPrice(item) && !item.applied;
}

/**
 * Rows the same model appears in more than once. A pricing page normally lists a
 * standard rate and a cache-hit rate per model, and the extractor turns those
 * into separate rows — so checking both would have the second one overwrite the
 * first. The server refuses that outright (409); here it just means neither row
 * is pre-checked, so the choice is made deliberately.
 */
function contestedSlugs(items) {
  const counts = new Map();
  // Counts every priced row for the model, including ones already applied. After
  // a partial apply the leftover row would otherwise look like the only candidate
  // for that model and get pre-checked — which is exactly how a cache-hit rate
  // ends up overwriting the standard rate a moment after it was set correctly.
  for (const item of items) {
    if (!item.modelSlug || !hasProposedPrice(item)) continue;
    counts.set(item.modelSlug, (counts.get(item.modelSlug) || 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([slug]) => slug));
}

function defaultSelection(items) {
  const contested = contestedSlugs(items);
  return new Set(
    items
      .filter(
        (item) => isApplicable(item) && !isNoChange(item) && !contested.has(item.modelSlug)
      )
      .map((i) => i._id)
  );
}

/** A price move worth colouring: up is bad (we pay more), down is good. */
function deltaBadge(current, next) {
  if (next == null) return null;
  if (current == null) return { text: 'new', tone: 'neutral' };
  const delta = priceDelta(current, next);
  if (!delta) return null;
  if (delta === 'new') return { text: 'new', tone: 'neutral' };
  return { text: delta, tone: delta.startsWith('+') ? 'bad' : 'good' };
}

function PriceCell({ current, next }) {
  const badge = deltaBadge(current, next);
  return (
    <div className="flex items-center justify-end gap-1.5 tabular-nums">
      <span className={next == null ? 'text-zinc-600' : 'text-zinc-100'}>{formatPrice(next)}</span>
      {badge && (
        <Badge tone={badge.tone} title={`was ${formatPrice(current)}`}>
          {badge.text}
        </Badge>
      )}
    </div>
  );
}

function confidenceTone(value) {
  if (value == null) return 'neutral';
  if (value >= 0.8) return 'good';
  if (value >= 0.5) return 'warn';
  return 'bad';
}

export default function ProposalDrawer() {
  const proposal = useAdminStore((s) => s.activeProposal);
  const providers = useAdminStore((s) => s.providers);
  const models = useAdminStore((s) => s.models);
  const busyMap = useAdminStore((s) => s.busy);
  const closeProposal = useAdminStore((s) => s.closeProposal);
  const applyProposal = useAdminStore((s) => s.applyProposal);
  const discardProposal = useAdminStore((s) => s.discardProposal);

  const items = proposal?.items || [];
  // Applying rewrites the proposal in the store, which changes what "already
  // applied" means. Keying the picks to the applied-state signature re-derives
  // the defaults after an apply without an effect that could run stale.
  const signature = `${proposal?._id}|${items.map((i) => `${i._id}:${i.applied ? 1 : 0}`).join(',')}`;
  const contested = contestedSlugs(items);
  const [picked, setPicked] = useState({ key: null, ids: new Set() });
  const selected = picked.key === signature ? picked.ids : defaultSelection(items);

  const replace = (ids) => setPicked({ key: signature, ids });
  const toggle = (id, on) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    replace(next);
  };

  const provider = providers.find((p) => p.slug === proposal?.providerSlug) || null;
  const adminModel = proposal?.adminModelId
    ? models.find((m) => m.slug === proposal.adminModelId) || null
    : null;
  const failed = proposal?.status === 'failed';
  const applyBusy = Boolean(busyMap[`proposal:${proposal?._id}:apply`]);
  const discardBusy = Boolean(busyMap[`proposal:${proposal?._id}:discard`]);
  const applicableCount = items.filter(isApplicable).length;

  return (
    <Modal
      wide
      title="Review proposed prices"
      description="Nothing has been written yet. Tick the rows you trust, then apply."
      onClose={closeProposal}
      footer={
        <>
          <div className="mr-auto">
            <ConfirmInline
              label="Discard"
              busy={discardBusy}
              onConfirm={() => discardProposal(proposal._id)}
            >
              <Button size="sm" variant="danger">
                Discard proposal
              </Button>
            </ConfirmInline>
          </div>
          <Button variant="ghost" onClick={closeProposal}>
            Cancel
          </Button>
          {!failed && (
            <Button
              variant="primary"
              icon={Check}
              busy={applyBusy}
              disabled={selected.size === 0}
              onClick={() => applyProposal(proposal._id, [...selected])}
            >
              Apply {selected.size} selected
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: provider?.color || '#71717a' }}
            />
            <span className="text-sm font-medium text-zinc-100">
              {provider?.name || proposal?.providerSlug}
            </span>
            {proposal?.modelSlug ? (
              <>
                <Badge tone="accent">one model</Badge>
                <Mono>{proposal.modelSlug}</Mono>
              </>
            ) : (
              <Badge tone="accent">whole company</Badge>
            )}
            <span className="text-zinc-500" title={fullDate(proposal?.createdAt)}>
              fetched {timeAgo(proposal?.createdAt)}
            </span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
            {proposal?.sourceUrl && (
              <a
                href={proposal.sourceUrl}
                target="_blank"
                rel="noreferrer"
                title={proposal.sourceUrl}
                className="inline-flex max-w-[24rem] items-center gap-1 text-indigo-300 hover:text-indigo-200"
              >
                <ExternalLink size={11} className="shrink-0" />
                <span className="truncate">{proposal.sourceUrl}</span>
              </a>
            )}
            <span className="inline-flex items-center gap-1 text-zinc-500">
              <Sparkles size={11} />
              read by {adminModel?.name || proposal?.adminModelId || 'the admin model'}
              {/* The admin LLM's bill for this one fetch — it scales with the size of
                  the page, not with the provider being priced. */}
              {proposal?.costUsd != null && (
                <span
                  className="text-zinc-400"
                  title={`${(proposal.usage?.totalTokens ?? 0).toLocaleString()} tokens`}
                >
                  · cost {formatPrice(proposal.costUsd)}
                </span>
              )}
            </span>
          </div>
        </div>

        {failed && (
          <Callout tone="bad">
            <strong>The extraction failed.</strong>{' '}
            {proposal.error || 'No reason was recorded.'} Nothing was written — check the URL, then
            try again.
          </Callout>
        )}

        {proposal?.truncated && (
          <Callout tone="warn">
            The page was cut short at {(proposal.usedChars ?? 0).toLocaleString()} of{' '}
            {(proposal.pageChars ?? 0).toLocaleString()} characters, so models listed further down
            may be missing from this list. Raise the character cap on the Settings tab, or fetch that
            model on its own.
          </Callout>
        )}

        {proposal?.warnings?.length > 0 && (
          <Callout tone="warn">
            <div className="font-medium">The extractor rejected or doubted some rows:</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {proposal.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          </Callout>
        )}

        {contested.size > 0 && (
          <Callout tone="warn">
            The page prices {[...contested].join(', ')} more than once — typically a standard rate and
            a cache-hit rate. Those rows are left unchecked because applying two of them would make
            the second overwrite the first; tick the one you actually mean. Check the evidence column:
            a cache rate is often ~100× smaller than the standard one.
          </Callout>
        )}

        {!failed && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              <span>
                {selected.size} of {applicableCount} applicable row(s) selected
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => replace(new Set(items.filter(isApplicable).map((i) => i._id)))}
              >
                Select all
              </Button>
              <Button size="sm" variant="ghost" onClick={() => replace(new Set())}>
                Clear
              </Button>
            </div>

            <TableWrap>
              <table className="w-full min-w-[56rem] border-collapse">
                <thead>
                  <tr>
                    <Th className="w-10" />
                    <Th>Model</Th>
                    <Th>On the page</Th>
                    <Th align="right">Current in / out</Th>
                    <Th align="right">Proposed in / out</Th>
                    <Th align="center">Confidence</Th>
                    <Th>Evidence</Th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const registryModel = item.modelSlug
                      ? models.find((m) => m.slug === item.modelSlug) || null
                      : null;
                    const unmatched = !item.modelSlug;
                    const noChange = isNoChange(item);
                    const priceless = !hasProposedPrice(item);
                    const disabled = unmatched || item.applied || priceless;
                    const evidence = item.evidence || '';
                    const longEvidence = evidence.length > EVIDENCE_MAX_CHARS;

                    return (
                      <tr
                        key={item._id}
                        className={clsx(
                          'align-top hover:bg-white/[0.02]',
                          (noChange || item.applied) && 'opacity-55'
                        )}
                      >
                        <Td>
                          <Checkbox
                            checked={selected.has(item._id)}
                            disabled={disabled}
                            onChange={(on) => toggle(item._id, on)}
                          />
                        </Td>

                        <Td>
                          {unmatched ? (
                            <div className="space-y-1">
                              <div className="text-zinc-300">{item.label || '(no label)'}</div>
                              <Badge tone="warn">not in registry</Badge>
                              <div className="text-[11px] leading-4 text-zinc-500">
                                Add this model on the Models tab first, then fetch again.
                              </div>
                            </div>
                          ) : (
                            <div className="space-y-1">
                              <div className="font-medium text-zinc-100">
                                {registryModel?.name || item.modelSlug}
                              </div>
                              <div className="flex flex-wrap items-center gap-1.5">
                                <Mono>{item.modelSlug}</Mono>
                                {item.matchedBy && item.matchedBy !== 'slug' && (
                                  <Badge title="How the page row was tied to this model">
                                    by {item.matchedBy}
                                  </Badge>
                                )}
                                {item.applied && (
                                  <Badge tone="good" title={fullDate(item.appliedAt)}>
                                    applied
                                  </Badge>
                                )}
                                {noChange && !item.applied && <Badge>no change</Badge>}
                              </div>
                            </div>
                          )}
                        </Td>

                        <Td className="max-w-[12rem]">
                          <div className="truncate text-zinc-400" title={item.label || undefined}>
                            {item.label || '—'}
                          </div>
                          {item.apiModel && (
                            <div className="mt-1 truncate font-mono text-[11px] text-zinc-500" title={item.apiModel}>
                              {item.apiModel}
                            </div>
                          )}
                          {item.unit && (
                            <div className="mt-1 text-[11px] text-zinc-500">{item.unit}</div>
                          )}
                        </Td>

                        <Td align="right" className="whitespace-nowrap tabular-nums text-zinc-400">
                          {formatPrice(item.currentIn)} / {formatPrice(item.currentOut)}
                        </Td>

                        <Td align="right" className="whitespace-nowrap">
                          <PriceCell current={item.currentIn} next={item.inPrice} />
                          <PriceCell current={item.currentOut} next={item.outPrice} />
                          {item.cachedInPrice != null && (
                            <div className="mt-1 text-[11px] text-zinc-500">
                              cached in {formatPrice(item.cachedInPrice)}
                            </div>
                          )}
                          {item.currency && item.currency !== 'USD' && (
                            <div className="mt-1">
                              <Badge tone="warn">{item.currency}</Badge>
                            </div>
                          )}
                        </Td>

                        <Td align="center">
                          <Badge tone={confidenceTone(item.confidence)}>
                            {item.confidence == null
                              ? '—'
                              : `${Math.round(item.confidence * 100)}%`}
                          </Badge>
                        </Td>

                        <Td className="max-w-[16rem]">
                          <span
                            title={longEvidence ? evidence : undefined}
                            className="block break-words text-[11px] leading-4 text-zinc-500"
                          >
                            {longEvidence
                              ? `${evidence.slice(0, EVIDENCE_MAX_CHARS - 1)}…`
                              : evidence || '—'}
                          </span>
                        </Td>
                      </tr>
                    );
                  })}

                  {!items.length && (
                    <EmptyRow colSpan={7}>
                      The extractor found no price rows on that page.
                    </EmptyRow>
                  )}
                </tbody>
              </table>
            </TableWrap>

            <Callout tone="info" icon={Info}>
              Applying overwrites each ticked model’s stored price and every user’s cost figures
              change with it. The old value is kept in that model’s price history (Models tab → edit
              → Price history), so a bad apply can be read back and corrected by hand.
            </Callout>
          </>
        )}
      </div>
    </Modal>
  );
}
