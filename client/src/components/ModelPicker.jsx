import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Image as ImageIcon, Lock } from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '../store/useStore.js';

/**
 * Model picker grouped by company. Models whose company has no API key
 * configured are shown locked. Switching applies immediately — even
 * mid-conversation.
 */
export default function ModelPicker({ compact = false }) {
  const { companies, models, selectedModelId, setModel, streaming } = useStore();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const selected = models.find((m) => m.id === selectedModelId);
  const selectedCompany = companies.find((c) => c.id === selected?.company);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={clsx(
          'flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] text-sm transition-colors hover:bg-white/[0.08]',
          compact ? 'px-3 py-1.5' : 'px-3.5 py-2'
        )}
      >
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: selectedCompany?.color || '#71717a' }}
        />
        <span className="max-w-[160px] truncate font-medium text-zinc-200">
          {selected?.name || 'Select model'}
        </span>
        <ChevronDown
          size={14}
          className={clsx('text-zinc-500 transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-2 max-h-[60vh] w-80 overflow-y-auto rounded-2xl border border-white/10 bg-surface-850 p-2 shadow-2xl shadow-black/60 animate-fade-in">
          {companies.map((company) => {
            const companyModels = models.filter((m) => m.company === company.id);
            if (!companyModels.length) return null;
            return (
              <div key={company.id} className="mb-1 last:mb-0">
                <div className="flex items-center gap-2 px-3 pb-1 pt-2.5">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: company.color }}
                  />
                  <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                    {company.name}
                  </span>
                  {!company.available && (
                    <span className="ml-auto text-[10px] text-zinc-600">no API key</span>
                  )}
                </div>
                {companyModels.map((model) => {
                  const disabled = !company.available;
                  const active = model.id === selectedModelId;
                  return (
                    <button
                      key={model.id}
                      type="button"
                      disabled={disabled || streaming}
                      onClick={() => {
                        setModel(model.id);
                        setOpen(false);
                      }}
                      className={clsx(
                        'flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors',
                        disabled
                          ? 'cursor-not-allowed opacity-40'
                          : 'hover:bg-white/[0.06]',
                        active && 'bg-indigo-500/10'
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-sm font-medium text-zinc-100">
                          <span className="truncate">{model.name}</span>
                          {model.vision && (
                            <ImageIcon size={12} className="shrink-0 text-sky-400/70" aria-label="supports images" />
                          )}
                          {disabled && <Lock size={12} className="shrink-0 text-zinc-600" />}
                        </div>
                        {model.tagline && (
                          <div className="truncate text-xs text-zinc-500">{model.tagline}</div>
                        )}
                      </div>
                      {active && <Check size={15} className="shrink-0 text-indigo-400" />}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
