import { ArrowDown, ArrowUp, Coins, Image as ImageIcon, Sigma } from 'lucide-react';
import { useStore } from '../store/useStore.js';
import { formatCost, formatTokens, formatTokensFull, messageCost } from '../lib/usage.js';

function UsageTable({ usage, model }) {
  if (!usage) return null;
  const total = usage.totalTokens ?? (usage.inputTokens || 0) + (usage.outputTokens || 0);
  const rows = [
    {
      label: 'Input',
      tokens: usage.inputTokens,
      rate: model?.price?.in,
      subtotal: model?.price ? (usage.inputTokens * model.price.in) / 1e6 : null,
    },
    {
      label: 'Output',
      tokens: usage.outputTokens,
      rate: model?.price?.out,
      subtotal: model?.price ? (usage.outputTokens * model.price.out) / 1e6 : null,
    },
  ];
  return (
    <table className="w-full text-[11px] tabular-nums">
      <tbody>
        {rows.map((r) => (
          <tr key={r.label} className="border-t border-white/[0.06] text-zinc-400">
            <td className="py-1.5">{r.label}</td>
            <td className="py-1.5 text-right text-zinc-200">{formatTokensFull(r.tokens)}</td>
            <td className="py-1.5 text-right">{r.rate != null ? `$${r.rate}` : '—'}</td>
            <td className="py-1.5 text-right text-zinc-200">
              {r.subtotal != null ? formatCost(r.subtotal) : '—'}
            </td>
          </tr>
        ))}
        {usage.reasoningTokens > 0 && (
          <tr className="border-t border-white/[0.06] text-zinc-500">
            <td className="py-1.5" colSpan={2}>
              of which reasoning
            </td>
            <td className="py-1.5 text-right" colSpan={2}>
              {formatTokensFull(usage.reasoningTokens)}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function ModelHeader({ model, company, label }) {
  return (
    <div className="flex items-start gap-2.5">
      <span
        className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: company?.color || '#71717a' }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-xs font-semibold text-zinc-100">
            {model?.name || 'Unknown model'}
          </span>
          <span className="shrink-0 text-[10px] text-zinc-500">{label}</span>
        </div>
        {model?.apiModel && (
          <div className="mt-0.5 font-mono text-[10px] text-zinc-500">{model.apiModel}</div>
        )}
      </div>
    </div>
  );
}

/**
 * Footer under every assistant message: model identity + token usage + cost.
 * Two-model image flow shows BOTH models (image understanding + reply) with
 * combined totals in the pill and per-model sections on hover.
 */
export default function MessageMeta({ message, isStreaming = false }) {
  const { modelById, companyForModel } = useStore();
  const model = modelById(message.modelId);
  const company = companyForModel(message.modelId);
  const visionModel = message.visionUsage ? modelById(message.visionUsage.modelId) : null;
  const visionCompany = message.visionUsage ? companyForModel(message.visionUsage.modelId) : null;
  const usage = message.usage;
  const visionUsage = message.visionUsage;
  if (!model && !usage) return null;

  const mainTotal = usage ? usage.totalTokens ?? (usage.inputTokens || 0) + (usage.outputTokens || 0) : 0;
  const visionTotal = visionUsage
    ? visionUsage.totalTokens ?? (visionUsage.inputTokens || 0) + (visionUsage.outputTokens || 0)
    : 0;
  const total = mainTotal + visionTotal;

  const mainCost = messageCost(usage, model);
  const visionCost = messageCost(visionUsage, visionModel);
  const cost = mainCost != null || visionCost != null ? (mainCost || 0) + (visionCost || 0) : null;
  const costStr = formatCost(cost);
  const liveTokens = isStreaming ? Math.ceil(message.content.length / 4) : 0;

  return (
    <div className="group relative mt-2.5 inline-block">
      {/* Pill */}
      <div className="flex cursor-default items-center gap-2.5 rounded-full border border-white/[0.07] bg-white/[0.03] px-3 py-1.5 text-[11px] font-medium tabular-nums text-zinc-500 transition-colors group-hover:border-indigo-500/30 group-hover:text-zinc-300">
        <span className="flex items-center gap-1.5 text-zinc-400">
          <span
            className={`h-1.5 w-1.5 rounded-full ${isStreaming ? 'animate-pulse' : ''}`}
            style={{ backgroundColor: company?.color || '#71717a' }}
          />
          {model?.name || message.modelId}
        </span>
        {visionModel && (
          <span className="flex items-center gap-1 text-zinc-500" title={`Images analyzed by ${visionModel.name}`}>
            <ImageIcon size={11} style={{ color: visionCompany?.color || '#71717a' }} />
            {visionModel.name}
          </span>
        )}

        {isStreaming && liveTokens > 10 && (
          <span className="flex items-center gap-1 border-l border-white/10 pl-2.5 text-indigo-300/80">
            ~{formatTokens(liveTokens)} tok
          </span>
        )}

        {!isStreaming && usage && (
          <>
            <span className="flex items-center gap-1 border-l border-white/10 pl-2.5" title="Input tokens">
              <ArrowUp size={11} className="text-sky-400/80" />
              {formatTokens((usage.inputTokens || 0) + (visionUsage?.inputTokens || 0))}
            </span>
            <span className="flex items-center gap-1" title="Output tokens">
              <ArrowDown size={11} className="text-violet-400/80" />
              {formatTokens((usage.outputTokens || 0) + (visionUsage?.outputTokens || 0))}
            </span>
            <span className="flex items-center gap-1" title="Total tokens">
              <Sigma size={11} />
              {formatTokens(total)}
            </span>
            {costStr && (
              <span className="flex items-center gap-1 font-semibold text-emerald-400/90" title="Estimated cost">
                <Coins size={11} />
                {costStr}
              </span>
            )}
          </>
        )}
      </div>

      {/* Hover detail card */}
      <div className="pointer-events-none absolute bottom-full left-0 z-40 mb-2 w-80 translate-y-1 rounded-xl border border-white/10 bg-surface-800 p-3.5 opacity-0 shadow-2xl shadow-black/60 transition-all duration-150 group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100">
        {/* Image model section (two-model flow) */}
        {visionUsage && (
          <div className="mb-3">
            <ModelHeader model={visionModel} company={visionCompany} label="image understanding" />
            <div className="mt-1.5">
              <UsageTable usage={visionUsage} model={visionModel} />
            </div>
          </div>
        )}

        {/* Reply model section */}
        <div className={visionUsage ? 'border-t border-white/10 pt-2.5' : ''}>
          <ModelHeader
            model={model}
            company={company}
            label={company?.name.replace(' (no key needed)', '') || ''}
          />
          {model?.tagline && (
            <p className="mb-1 mt-1 pl-5 text-[11px] leading-4 text-zinc-400">{model.tagline}</p>
          )}
          {usage ? (
            <div className="mt-1.5">
              <UsageTable usage={usage} model={model} />
            </div>
          ) : (
            <p className="mt-1.5 pl-5 text-[10px] leading-4 text-zinc-600">
              {isStreaming ? 'Generating… usage appears when the reply completes.' : 'No usage data recorded for this message.'}
            </p>
          )}
        </div>

        {/* Grand total */}
        {(usage || visionUsage) && (
          <div className="mt-2 flex items-center justify-between border-t border-white/10 pt-2 text-[11px] font-semibold text-zinc-200 tabular-nums">
            <span>Total · {formatTokensFull(total)} tokens</span>
            <span className="text-emerald-400">{costStr || '—'}</span>
          </div>
        )}

        {usage && !model?.price && !visionUsage && (
          <p className="mt-1.5 text-[10px] leading-4 text-zinc-600">
            No price data for this model — add it to the registry to see cost estimates.
          </p>
        )}
        {(usage || visionUsage) && (
          <p className="mt-1.5 text-[10px] text-zinc-600">
            Provider-reported usage; cache-hit discounts not included.
          </p>
        )}
      </div>
    </div>
  );
}
