import {
  Building2,
  ChevronRight,
  CircleCheck,
  Cpu,
  Info,
  KeyRound,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Tags,
  Users,
} from 'lucide-react';
import { useAdminStore } from '../useAdminStore.js';
import {
  Badge,
  Button,
  Callout,
  Card,
  ConfirmInline,
  EmptyRow,
  Mono,
  Spinner,
  StatTile,
  TableWrap,
  Td,
  Th,
} from './ui.jsx';
import { formatPrice, fullDate, timeAgo } from '../lib/format.js';

/**
 * Landing panel: what the registry currently looks like, what the last 30 days
 * cost, and what still needs configuring. Everything here comes from a single
 * `GET /admin/overview` snapshot the store loaded at boot.
 */

const PROPOSAL_TONES = {
  ready: 'info',
  applied: 'good',
  'partially-applied': 'warn',
  failed: 'bad',
  discarded: 'neutral',
};

const num = (value) => Number(value || 0).toLocaleString();

/**
 * How provider keys are encrypted at rest, plus the consequence of it — the
 * JWT_SECRET fallback works but silently loses every stored key if that secret
 * is ever rotated, which is worth saying out loud.
 */
function encryptionState(encryption) {
  if (!encryption?.available) {
    return {
      tone: 'bad',
      icon: ShieldAlert,
      label: 'keys cannot be stored',
      note: 'API keys can’t be saved to the database. Set ENCRYPTION_KEY in server/.env and restart the server — until then, companies only work from environment variables.',
    };
  }
  if (encryption.source === 'JWT_SECRET') {
    return {
      tone: 'warn',
      icon: ShieldAlert,
      label: 'JWT_SECRET',
      note: 'Stored keys are encrypted with a fallback derived from JWT_SECRET — rotating that secret makes every saved key unreadable. Set a dedicated ENCRYPTION_KEY.',
    };
  }
  return { tone: 'good', icon: ShieldCheck, label: encryption.source, note: null };
}

/** Label/value row used by the registry card. */
function InfoRow({ label, children }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-5 py-3">
      <span className="w-36 shrink-0 text-xs font-medium text-zinc-500">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm text-zinc-300">
        {children}
      </div>
    </div>
  );
}


/**
 * What the dashboard itself costs. Price fetches and key tests are real billed
 * model calls, and they leave no trace in the Message collection, so without this
 * they are spend with no line item anywhere.
 */
const ADMIN_KIND_LABELS = {
  price_fetch: 'Price fetches',
  key_test: 'Key tests',
};

function AdminSpend({ adminUsage, chatCost }) {
  const rows = adminUsage.rows || [];
  const days = adminUsage.days ?? 30;
  const calls = adminUsage.calls ?? 0;
  const cost = adminUsage.estimatedCostUsd ?? 0;
  const unpriced = adminUsage.unpricedCalls ?? 0;

  const byKind = rows.reduce((acc, row) => {
    const key = row.kind;
    acc[key] = acc[key] || { calls: 0, costUsd: 0, failures: 0 };
    acc[key].calls += row.calls;
    acc[key].costUsd += row.costUsd || 0;
    acc[key].failures += row.failures || 0;
    return acc;
  }, {});

  const total = (chatCost || 0) + cost;
  const share = total > 0 ? Math.round((cost / total) * 100) : 0;

  return (
    <Card
      title={`Admin operations (last ${days} days)`}
      description="Every paid call the dashboard makes on your behalf — reading a pricing page with the admin LLM, and testing a provider key. Logged per call with tokens and cost."
    >
      <div className="flex flex-wrap items-baseline gap-x-10 gap-y-3 border-b border-white/[0.06] px-5 py-4">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            Admin cost
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-zinc-100">
            {formatPrice(cost)}
          </div>
        </div>
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            Paid calls
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-zinc-100">{num(calls)}</div>
        </div>
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">Tokens</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-zinc-100">
            {num((adminUsage.inputTokens || 0) + (adminUsage.outputTokens || 0))}
          </div>
        </div>
        {calls > 0 && (
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              Share of all spend
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-zinc-100">{share}%</div>
          </div>
        )}
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(byKind).map(([kind, agg]) => (
            <Badge key={kind} tone={agg.failures ? 'warn' : 'neutral'}>
              {ADMIN_KIND_LABELS[kind] || kind}: {agg.calls} · {formatPrice(agg.costUsd)}
              {agg.failures ? ` · ${agg.failures} failed` : ''}
            </Badge>
          ))}
        </div>
      </div>

      {unpriced > 0 && (
        <div className="px-5 pt-4">
          <Callout tone="warn">
            {unpriced} call{unpriced === 1 ? '' : 's'} used a model with no price set, so the figure
            above is a floor, not the whole bill. Set that model’s price on the Models tab.
          </Callout>
        </div>
      )}

      <TableWrap>
        <table className="w-full min-w-[44rem] border-collapse">
          <thead>
            <tr>
              <Th>Operation</Th>
              <Th>Model billed</Th>
              <Th align="right">Calls</Th>
              <Th align="right">Input</Th>
              <Th align="right">Output</Th>
              <Th align="right">Cost</Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <EmptyRow colSpan={6}>
                No paid admin calls yet. Fetching prices or testing a key will appear here.
              </EmptyRow>
            ) : (
              rows.map((row) => (
                <tr key={`${row.kind}:${row.modelId}`}>
                  <Td>
                    <div className="flex items-center gap-2">
                      <span>{ADMIN_KIND_LABELS[row.kind] || row.kind}</span>
                      {row.failures > 0 && (
                        <Badge tone="warn" title="Failed calls can still be billed for input tokens">
                          {row.failures} failed
                        </Badge>
                      )}
                    </div>
                  </Td>
                  <Td>
                    <div className="text-zinc-200">{row.modelName}</div>
                    {row.companyName && (
                      <div className="text-[11px] text-zinc-500">{row.companyName}</div>
                    )}
                  </Td>
                  <Td align="right" className="tabular-nums">{num(row.calls)}</Td>
                  <Td align="right" className="tabular-nums">{num(row.inputTokens)}</Td>
                  <Td align="right" className="tabular-nums">{num(row.outputTokens)}</Td>
                  <Td align="right" className="tabular-nums">
                    {row.unpriced ? (
                      <Badge tone="warn">no price</Badge>
                    ) : (
                      <span className="text-emerald-400">{formatPrice(row.costUsd)}</span>
                    )}
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </TableWrap>
    </Card>
  );
}

export default function OverviewPanel() {
  const overview = useAdminStore((s) => s.overview);
  const reloadRegistry = useAdminStore((s) => s.reloadRegistry);
  const reseedRegistry = useAdminStore((s) => s.reseedRegistry);
  const openProposal = useAdminStore((s) => s.openProposal);
  // Selecting the boolean rather than `isBusy` itself: the helper's identity is
  // stable, so subscribing to it would never re-render when the flag flips.
  const reloadBusy = useAdminStore((s) => s.isBusy('registry:reload'));
  const reseedBusy = useAdminStore((s) => s.isBusy('registry:reseed'));

  if (!overview) return <Spinner label="Loading the overview…" />;

  const counts = overview.counts || {};
  const registry = overview.registry || {};
  const usage = overview.usage || {};
  const byModel = usage.byModel || [];
  const adminUsage = overview.adminUsage || {};
  const issues = overview.issues || [];
  const recentProposals = overview.recentProposals || [];
  const adminModel = overview.adminModel;
  const encryption = encryptionState(overview.encryption);

  const activeProviders = counts.activeProviders ?? 0;
  const activeModels = counts.activeModels ?? 0;
  const pricedModels = counts.pricedModels ?? 0;
  const admins = counts.admins ?? 0;
  const days = usage.days ?? 30;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile
          icon={Building2}
          label="Companies"
          value={`${activeProviders} / ${counts.providers ?? 0}`}
          hint="active / configured"
          tone={activeProviders === 0 ? 'warn' : 'default'}
        />
        <StatTile
          icon={Cpu}
          label="Models"
          value={`${activeModels} / ${counts.models ?? 0}`}
          hint="active / configured"
          tone={activeModels === 0 ? 'warn' : 'default'}
        />
        <StatTile
          icon={Tags}
          label="Priced"
          value={`${pricedModels} / ${counts.models ?? 0}`}
          hint="models with a price"
          tone={pricedModels < activeModels ? 'warn' : 'default'}
        />
        <StatTile
          icon={KeyRound}
          label="Keys in DB"
          value={registry.keysInDb ?? 0}
          hint="encrypted, not from .env"
        />
        <StatTile
          icon={Users}
          label="Users"
          value={num(counts.users)}
          hint={`${admins} admin${admins === 1 ? '' : 's'}`}
        />
        <StatTile icon={MessageSquare} label="Messages" value={num(counts.messages)} hint="all time" />
      </div>

      <AdminSpend adminUsage={adminUsage} chatCost={usage.estimatedCostUsd} />

      <Card
        title={`Spend (last ${days} days)`}
        description="Estimated from the token counts stored on each assistant message and the model’s current price."
      >
        <div className="flex flex-wrap items-baseline gap-x-10 gap-y-3 border-b border-white/[0.06] px-5 py-4">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              Estimated cost
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-zinc-100">
              {formatPrice(usage.estimatedCostUsd)}
            </div>
          </div>
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              Assistant messages
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-zinc-100">
              {num(usage.messages)}
            </div>
          </div>
        </div>
        <TableWrap>
          <table className="w-full min-w-[46rem] border-collapse">
            <thead>
              <tr>
                <Th>Model</Th>
                <Th>Company</Th>
                <Th align="right">Messages</Th>
                <Th align="right">Input</Th>
                <Th align="right">Output</Th>
                <Th align="right">Est. cost</Th>
              </tr>
            </thead>
            <tbody>
              {byModel.length === 0 ? (
                <EmptyRow colSpan={6}>No messages have been sent in the last {days} days.</EmptyRow>
              ) : (
                byModel.map((row) => (
                  <tr key={row.modelId}>
                    <Td>
                      <div className="font-medium text-zinc-200">{row.name || row.modelId}</div>
                      <div className="mt-0.5 font-mono text-[11px] text-zinc-500">{row.modelId}</div>
                    </Td>
                    <Td className="text-zinc-400">{row.companyName || '—'}</Td>
                    <Td align="right" className="tabular-nums">
                      {num(row.messages)}
                    </Td>
                    <Td align="right" className="tabular-nums text-zinc-400">
                      {num(row.inputTokens)}
                    </Td>
                    <Td align="right" className="tabular-nums text-zinc-400">
                      {num(row.outputTokens)}
                    </Td>
                    <Td align="right" className="tabular-nums">
                      {row.priced ? (
                        formatPrice(row.costUsd)
                      ) : (
                        <Badge tone="warn" title="This model has no price, so its usage is not costed">
                          no price
                        </Badge>
                      )}
                    </Td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </TableWrap>
      </Card>

      <Card title="Attention" description="Configuration gaps that stop models from being usable.">
        <div className="space-y-2.5 px-5 py-4">
          {issues.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-emerald-300">
              <CircleCheck size={14} className="shrink-0" />
              Everything looks configured.
            </div>
          ) : (
            issues.map((issue) => (
              <Callout
                key={`${issue.kind}:${issue.target || ''}`}
                tone={issue.severity === 'warn' ? 'warn' : 'info'}
                icon={issue.severity === 'warn' ? undefined : Info}
              >
                {issue.message}
                {issue.target && <Mono className="ml-1.5">{issue.target}</Mono>}
              </Callout>
            ))
          )}
        </div>
      </Card>

      <Card
        title="Registry"
        description="The in-memory cache of companies and models that the chat app serves to every user."
        actions={
          <>
            <Button size="sm" icon={RefreshCw} busy={reloadBusy} onClick={() => reloadRegistry()}>
              Reload
            </Button>
            {/* Reseeding writes to MongoDB, so it asks first. */}
            <ConfirmInline
              label="Reseed"
              tone="primary"
              busy={reseedBusy}
              onConfirm={() => reseedRegistry()}
            >
              <Button size="sm" icon={RotateCcw} title="Recreate any missing built-in companies and models">
                Restore defaults
              </Button>
            </ConfirmInline>
          </>
        }
      >
        {registry.usingFallback && (
          <div className="px-5 pt-4">
            <Callout tone="warn">
              The registry could not be read from MongoDB, so the built-in defaults are being served
              instead. Edits made here won’t reach users until the database is reachable again.
            </Callout>
          </div>
        )}
        <div className="divide-y divide-white/[0.04]">
          <InfoRow label="Loaded">
            <span title={fullDate(registry.loadedAt)}>{timeAgo(registry.loadedAt)}</span>
            <span className="text-zinc-500">
              {registry.companies ?? 0} companies, {registry.models ?? 0} models cached
            </span>
          </InfoRow>
          <InfoRow label="Admin LLM">
            {adminModel ? (
              <>
                <span className="text-zinc-200">{adminModel.name}</span>
                <span className="text-zinc-500">{adminModel.companyName || adminModel.company}</span>
              </>
            ) : (
              <>
                <Badge tone="warn">not configured</Badge>
                <span className="text-zinc-500">
                  Pick a model under Settings — price fetching needs one to read pricing pages.
                </span>
              </>
            )}
          </InfoRow>
          <InfoRow label="Key encryption">
            <Badge tone={encryption.tone} icon={encryption.icon}>
              {encryption.label}
            </Badge>
            {encryption.note && (
              <span className="min-w-0 flex-1 text-xs leading-5 text-zinc-500">{encryption.note}</span>
            )}
          </InfoRow>
        </div>
      </Card>

      {recentProposals.length > 0 && (
        <Card
          title="Recent price proposals"
          description="Extracted prices waiting to be reviewed. Nothing changes until a proposal is applied."
        >
          <ul className="divide-y divide-white/[0.04]">
            {recentProposals.map((proposal) => (
              <li key={proposal._id}>
                <button
                  type="button"
                  onClick={() => openProposal(proposal._id)}
                  className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 px-5 py-3 text-left transition-colors hover:bg-white/[0.03]"
                >
                  <Mono>{proposal.providerSlug}</Mono>
                  {proposal.modelSlug && (
                    <span className="text-xs text-zinc-500">{proposal.modelSlug}</span>
                  )}
                  <span className="text-xs text-zinc-400">
                    {proposal.appliedCount
                      ? `${proposal.appliedCount} of ${proposal.itemCount ?? 0} applied`
                      : `${proposal.itemCount ?? 0} row${proposal.itemCount === 1 ? '' : 's'}`}
                  </span>
                  <Badge tone={PROPOSAL_TONES[proposal.status] || 'neutral'}>{proposal.status}</Badge>
                  <span
                    className="ml-auto text-xs text-zinc-500"
                    title={fullDate(proposal.createdAt)}
                  >
                    {timeAgo(proposal.createdAt)}
                  </span>
                  <ChevronRight size={13} className="shrink-0 text-zinc-600" />
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
