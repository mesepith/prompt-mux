import { useState } from 'react';
import { ChevronDown, ChevronRight, Scissors } from 'lucide-react';
import clsx from 'clsx';

/**
 * What a targeted edit actually changed.
 *
 * The point of patch edits is that the model touches a few lines instead of
 * reproducing the document — but that is only trustworthy if you can see which
 * lines. So every hunk the server applied is shown here, removed above added,
 * collapsed by default because the working artifact is the thing worth looking at.
 *
 * `hunks` come from Message.artifactEdit.hunks (server/src/lib/patch.js): the
 * exact text that was found and the exact text that replaced it.
 */
export default function ArtifactDiff({ hunks, fallback }) {
  const [open, setOpen] = useState(false);
  if (!hunks?.length) return null;

  const lines = (text) => (text === '' ? [] : String(text).split('\n'));
  const removed = hunks.reduce((n, h) => n + lines(h.search).length, 0);
  const added = hunks.reduce((n, h) => n + lines(h.replace).length, 0);

  return (
    <div className="mt-2 overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.02]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] text-zinc-400 transition-colors hover:bg-white/[0.03]"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Scissors size={11} className="text-violet-400" />
        <span className="font-medium text-zinc-300">
          {hunks.length} targeted change{hunks.length === 1 ? '' : 's'}
        </span>
        <span className="font-mono text-emerald-400">+{added}</span>
        <span className="font-mono text-rose-400">−{removed}</span>
        {fallback === 'repair' && (
          <span className="ml-auto text-[10px] text-amber-400/80">took two tries</span>
        )}
      </button>

      {open && (
        <div className="max-h-80 overflow-auto border-t border-white/[0.06]">
          {hunks.map((hunk, i) => (
            <div key={i} className={clsx(i > 0 && 'border-t border-white/[0.06]')}>
              <div className="bg-white/[0.02] px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-zinc-600">
                change {i + 1} of {hunks.length}
              </div>
              <pre className="overflow-x-auto px-3 py-2 font-mono text-[12px] leading-5">
                {lines(hunk.search).map((line, k) => (
                  <div key={`r${k}`} className="text-rose-300/90">
                    <span className="select-none text-rose-500/60">− </span>
                    {line || ' '}
                  </div>
                ))}
                {lines(hunk.replace).map((line, k) => (
                  <div key={`a${k}`} className="text-emerald-300/90">
                    <span className="select-none text-emerald-500/60">+ </span>
                    {line || ' '}
                  </div>
                ))}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
