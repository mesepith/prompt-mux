import { Fragment, useMemo, useState } from 'react';
import { Eye, FileText, Pencil, Plus, Tags, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { useAdminStore } from '../useAdminStore.js';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmInline,
  EmptyRow,
  IconButton,
  Mono,
  Select,
  TableWrap,
  Td,
  TextInput,
  Th,
  Toggle,
} from './ui.jsx';
import { formatContext, formatPrice, fullDate, timeAgo } from '../lib/format.js';

/**
 * The models table — every model a user can pick, grouped by company, with the
 * admin-supplied cost. This is the screen the whole admin feature exists for:
 * prices here are what `MessageMeta` and `SessionUsage` bill the chat with, so
 * an unpriced model is called out rather than quietly rendered as $0.
 */

const COLUMNS = 10;

/**
 * The API refuses to delete a model that messages still reference (409
 * MODEL_IN_USE). The store only hands back the message, so read the count from
 * it and fall back to the row's own `usageCount`.
 */
function usageFromError(message) {
  const match = /(\d[\d,]*)\s*(?:message|conversation)/i.exec(String(message || ''));
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

function CompanyRow({ provider, fallback, count }) {
  const inactive = provider ? !provider.active : fallback.companyActive === false;
  return (
    <tr className="bg-white/[0.02]">
      <td colSpan={COLUMNS} className="border-b border-white/[0.06] px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: provider?.color || fallback.companyColor || '#71717a' }}
          />
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
            {provider?.name || fallback.companyName || fallback.company}
          </span>
          {inactive && (
            <Badge tone="warn">company off — these models are hidden</Badge>
          )}
          <span className="text-[11px] text-zinc-500">
            {count} model{count === 1 ? '' : 's'}
          </span>
        </div>
      </td>
    </tr>
  );
}

function PriceCell({ model }) {
  const price = model.price || {};
  const unpriced = price.in == null && price.out == null;

  if (unpriced) return <Badge tone="warn">no price</Badge>;
  return (
    <>
      <div className="tabular-nums text-zinc-200">{formatPrice(price.in)}</div>
      <div className="mt-0.5 flex items-center justify-end gap-1.5">
        <Badge tone={model.priceSource === 'fetched' ? 'good' : 'neutral'}>
          {model.priceSource || 'seed'}
        </Badge>
        <span className="text-[11px] text-zinc-500" title={fullDate(model.priceUpdatedAt)}>
          {timeAgo(model.priceUpdatedAt)}
        </span>
      </div>
    </>
  );
}

export default function ModelsPanel() {
  const models = useAdminStore((s) => s.models);
  const providers = useAdminStore((s) => s.providers);
  const modelQuery = useAdminStore((s) => s.modelQuery);
  const modelCompany = useAdminStore((s) => s.modelCompany);
  const showInactive = useAdminStore((s) => s.showInactive);
  const setModelQuery = useAdminStore((s) => s.setModelQuery);
  const setModelCompany = useAdminStore((s) => s.setModelCompany);
  const setShowInactive = useAdminStore((s) => s.setShowInactive);
  const visibleModels = useAdminStore((s) => s.visibleModels);
  const openModelEditor = useAdminStore((s) => s.openModelEditor);
  const openPriceFetch = useAdminStore((s) => s.openPriceFetch);
  const toggleModel = useAdminStore((s) => s.toggleModel);
  const deleteModel = useAdminStore((s) => s.deleteModel);
  const bulkSetModelActive = useAdminStore((s) => s.bulkSetModelActive);
  // Subscribe to the busy map itself: the store's `isBusy` helper keeps the same
  // identity forever, so selecting it alone would never repaint a row spinner.
  const busyMap = useAdminStore((s) => s.busy);
  const isBusy = (key) => Boolean(busyMap[key]);

  const [selected, setSelected] = useState(() => new Set());
  // Slug -> message count, set only after the server refused a delete, so the
  // "delete anyway" escape hatch never shows up before it's earned.
  const [inUse, setInUse] = useState({});

  // `visibleModels()` reads the store imperatively; the filter inputs are in the
  // deps so a keystroke or a refetch recomputes the list.
  const visible = useMemo(
    () => visibleModels(),
    [visibleModels, models, modelQuery, modelCompany, showInactive]
  );

  const orderedProviders = useMemo(
    () =>
      [...providers].sort(
        (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name)
      ),
    [providers]
  );

  const groups = useMemo(() => {
    const rank = new Map(orderedProviders.map((p, index) => [p.slug, index]));
    const byCompany = new Map();
    for (const model of visible) {
      if (!byCompany.has(model.company)) byCompany.set(model.company, []);
      byCompany.get(model.company).push(model);
    }
    return [...byCompany.entries()]
      .sort(
        ([a], [b]) =>
          (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER) ||
          a.localeCompare(b)
      )
      .map(([slug, rows]) => ({
        slug,
        provider: orderedProviders.find((p) => p.slug === slug) || null,
        rows,
      }));
  }, [visible, orderedProviders]);

  // Bulk actions only ever touch rows the admin can currently see, so a stale
  // selection hidden by a filter can't be deactivated by accident.
  const selectedVisible = visible.filter((m) => selected.has(m.slug));
  const allVisibleSelected = visible.length > 0 && selectedVisible.length === visible.length;
  const bulkBusy = isBusy('model:bulk');

  const toggleOne = (slug) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });

  const toggleAllVisible = () =>
    setSelected(allVisibleSelected ? new Set() : new Set(visible.map((m) => m.slug)));

  const applyBulk = async (active) => {
    const res = await bulkSetModelActive(
      selectedVisible.map((m) => m.slug),
      active
    );
    if (res.ok) setSelected(new Set());
  };

  const remove = async (model) => {
    const res = await deleteModel(model.slug);
    if (res.ok) {
      setInUse((prev) => {
        const next = { ...prev };
        delete next[model.slug];
        return next;
      });
      return res;
    }
    const count = usageFromError(res.error) ?? model.usageCount;
    if (count) setInUse((prev) => ({ ...prev, [model.slug]: count }));
    return res;
  };

  const companyOptions = [
    { value: 'all', label: 'All companies' },
    ...orderedProviders.map((p) => ({ value: p.slug, label: p.name })),
  ];

  return (
    <div className="space-y-4">
      <Card
        title="Models"
        description="Prices are USD per 1M tokens and drive every cost estimate in the chat. Deactivate a model to hide it from the picker without losing its history."
        actions={
          <Button variant="primary" icon={Plus} onClick={() => openModelEditor(null)}>
            Add model
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-3 px-5 py-4">
          <div className="min-w-[14rem] flex-1">
            <TextInput
              value={modelQuery}
              onChange={setModelQuery}
              placeholder="Search name, id or API model"
            />
          </div>
          <div className="w-48">
            <Select value={modelCompany} onChange={setModelCompany} options={companyOptions} />
          </div>
          <Checkbox checked={showInactive} onChange={setShowInactive} label="Show inactive" />
          <span className="text-xs text-zinc-500">
            {visible.length} of {models.length} models
          </span>
        </div>
      </Card>

      {selectedVisible.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-indigo-500/25 bg-indigo-500/[0.07] px-4 py-3">
          <span className="text-xs font-medium text-indigo-200">
            {selectedVisible.length} selected
          </span>
          <span className="flex-1" />
          <Button size="sm" variant="success" busy={bulkBusy} onClick={() => applyBulk(true)}>
            Activate
          </Button>
          <Button size="sm" variant="secondary" busy={bulkBusy} onClick={() => applyBulk(false)}>
            Deactivate
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      <Card>
        <TableWrap>
          <table className="w-full min-w-[68rem] border-collapse">
            <thead>
              <tr>
                <Th className="w-8">
                  <Checkbox
                    checked={allVisibleSelected}
                    onChange={toggleAllVisible}
                    disabled={visible.length === 0}
                  />
                </Th>
                <Th>Active</Th>
                <Th>Model</Th>
                <Th>API model</Th>
                <Th align="right">Input $/1M</Th>
                <Th align="right" title="Price for input the provider served from its prompt cache. Empty means cache hits are billed at the full input price, which overstates long chats.">
                  Cached in $/1M
                </Th>
                <Th align="right">Output $/1M</Th>
                <Th align="right">Context</Th>
                <Th>Caps</Th>
                <Th align="right">Used</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <EmptyRow colSpan={COLUMNS}>
                  {models.length === 0
                    ? 'No models yet — add one, or restore the built-in defaults from Settings.'
                    : 'No model matches the current filters. Clear the search, pick “All companies” or tick “Show inactive”.'}
                </EmptyRow>
              ) : (
                groups.map((group) => (
                  <Fragment key={group.slug}>
                    <CompanyRow
                      provider={group.provider}
                      fallback={group.rows[0]}
                      count={group.rows.length}
                    />
                    {group.rows.map((model) => {
                      const price = model.price || {};
                      const pendingForce = inUse[model.slug];
                      return (
                        <tr
                          key={model.slug}
                          className={clsx(
                            'transition-colors hover:bg-white/[0.02]',
                            !model.active && 'opacity-50'
                          )}
                        >
                          <Td>
                            <Checkbox
                              checked={selected.has(model.slug)}
                              onChange={() => toggleOne(model.slug)}
                            />
                          </Td>
                          <Td>
                            <Toggle
                              checked={model.active}
                              busy={isBusy(`model:${model.slug}:active`)}
                              onChange={(next) => toggleModel(model.slug, next)}
                              label={model.active ? 'Deactivate model' : 'Activate model'}
                            />
                          </Td>
                          <Td>
                            <div className="font-medium text-zinc-100">{model.name}</div>
                            {model.tagline && (
                              <div className="mt-0.5 max-w-[18rem] text-[11px] leading-4 text-zinc-500">
                                {model.tagline}
                              </div>
                            )}
                            <div className="mt-1">
                              <Mono>{model.slug}</Mono>
                            </div>
                          </Td>
                          <Td>
                            <Mono>{model.apiModel}</Mono>
                          </Td>
                          <Td align="right">
                            <PriceCell model={model} />
                          </Td>
                          {/* Blank is not "free" here, it is "unknown" — and an
                              unknown cache rate means hits get billed at the full
                              input price. Flagged rather than left as a bare dash. */}
                          <Td
                            align="right"
                            className={clsx(
                              'tabular-nums',
                              typeof price.cachedIn === 'number' ? 'text-emerald-300/90' : 'text-zinc-600'
                            )}
                            title={
                              typeof price.cachedIn === 'number'
                                ? `Cache hits cost ${Math.round((price.in || 0) / (price.cachedIn || 1))}x less than fresh input`
                                : 'Not set — cache hits are billed at the full input price. Fetch Prices can usually find it, or set it in Edit.'
                            }
                          >
                            {typeof price.cachedIn === 'number' ? formatPrice(price.cachedIn) : 'not set'}
                          </Td>
                          <Td align="right" className="tabular-nums text-zinc-200">
                            {formatPrice(price.out)}
                          </Td>
                          <Td align="right" className="tabular-nums text-zinc-400">
                            {formatContext(model.contextWindow)}
                          </Td>
                          <Td>
                            {model.vision || model.pdf ? (
                              <span className="flex flex-wrap gap-1">
                                {model.vision && (
                                  <Badge tone="info" icon={Eye} title="Accepts images directly">
                                    vision
                                  </Badge>
                                )}
                                {model.pdf && (
                                  <Badge tone="info" icon={FileText} title="Accepts native PDFs">
                                    pdf
                                  </Badge>
                                )}
                              </span>
                            ) : (
                              <span className="text-zinc-600">—</span>
                            )}
                          </Td>
                          <Td align="right">
                            <span
                              className="text-xs tabular-nums text-zinc-500"
                              title={`${model.usageCount || 0} message(s) reference this model`}
                            >
                              {model.usageCount ? model.usageCount.toLocaleString() : '—'}
                            </span>
                          </Td>
                          <Td align="right">
                            <div className="flex items-center justify-end gap-0.5">
                              <IconButton
                                icon={Pencil}
                                title="Edit model"
                                onClick={() => openModelEditor(model)}
                              />
                              <IconButton
                                icon={Tags}
                                title="Fetch prices for this model"
                                busy={isBusy(`price:${model.slug}`)}
                                onClick={() =>
                                  openPriceFetch({
                                    providerSlug: model.company,
                                    modelSlug: model.slug,
                                  })
                                }
                              />
                              {pendingForce ? (
                                <ConfirmInline
                                  label="Yes, delete it"
                                  busy={isBusy(`model:${model.slug}:delete`)}
                                  onConfirm={() => deleteModel(model.slug, { force: true })}
                                >
                                  <Button size="sm" variant="danger" icon={Trash2}>
                                    Delete anyway ({pendingForce.toLocaleString()} messages keep
                                    their history)
                                  </Button>
                                </ConfirmInline>
                              ) : (
                                <ConfirmInline
                                  label="Delete"
                                  busy={isBusy(`model:${model.slug}:delete`)}
                                  onConfirm={() => remove(model)}
                                >
                                  <IconButton icon={Trash2} tone="danger" title="Delete model" />
                                </ConfirmInline>
                              )}
                            </div>
                          </Td>
                        </tr>
                      );
                    })}
                  </Fragment>
                ))
              )}
            </tbody>
          </table>
        </TableWrap>
      </Card>
    </div>
  );
}
