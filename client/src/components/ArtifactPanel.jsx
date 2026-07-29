import { useMemo, useState } from 'react';
import { Check, Code2, Copy, ExternalLink, Eye, X } from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '../store/useStore.js';
import { buildPreviewDoc, openArtifactInNewTab } from '../lib/artifacts.js';

/**
 * Claude-Artifacts style side panel: live sandboxed preview + source view.
 * The iframe is sandboxed with only allow-scripts — no same-origin access.
 */
export default function ArtifactPanel() {
  const { activeArtifact, closeArtifact } = useStore();
  const [tab, setTab] = useState('preview');
  const [copied, setCopied] = useState(false);

  const doc = useMemo(() => buildPreviewDoc(activeArtifact), [activeArtifact]);

  if (!activeArtifact) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(activeArtifact.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="flex h-full w-full flex-col border-l border-white/[0.06] bg-surface-900 animate-slide-in max-lg:absolute max-lg:inset-0 max-lg:z-30 lg:w-[46%] lg:shrink-0">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-zinc-100">
            {activeArtifact.title}
          </div>
          <div className="text-[11px] uppercase tracking-wider text-zinc-500">
            {activeArtifact.language} artifact
          </div>
        </div>

        {/* Tabs */}
        <div className="flex rounded-lg bg-white/[0.05] p-0.5">
          {[
            { id: 'preview', icon: Eye, label: 'Preview' },
            { id: 'code', icon: Code2, label: 'Code' },
          ].map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={clsx(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                tab === id ? 'bg-white/10 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
              )}
            >
              <Icon size={13} />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>

        <button
          type="button"
          title="Open in new tab"
          onClick={() => openArtifactInNewTab(activeArtifact)}
          className="rounded-lg p-2 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
        >
          <ExternalLink size={15} />
        </button>
        <button
          type="button"
          title="Copy code"
          onClick={copy}
          className="rounded-lg p-2 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
        >
          {copied ? <Check size={15} className="text-emerald-400" /> : <Copy size={15} />}
        </button>
        <button
          type="button"
          title="Close panel"
          onClick={closeArtifact}
          className="rounded-lg p-2 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
        >
          <X size={16} />
        </button>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1">
        {tab === 'preview' ? (
          <iframe
            key={doc.length}
            title={activeArtifact.title}
            sandbox="allow-scripts"
            srcDoc={doc}
            className="h-full w-full border-0 bg-white"
          />
        ) : (
          <pre className="h-full overflow-auto p-4 font-mono text-[12.5px] leading-5 text-zinc-300">
            {activeArtifact.code}
          </pre>
        )}
      </div>
    </div>
  );
}
