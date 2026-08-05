import { useEffect, useState } from 'react';
import { Check, ExternalLink, Globe, Link2, Loader2, Lock, Share2, X } from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '../store/useStore.js';
import { artifactUrl } from '../lib/router.js';
import { copyToClipboard } from '../lib/clipboard.js';

/**
 * Share dialog for a published artifact.
 *
 * The link exists from the moment the dialog opens (the panel publishes on
 * demand), but it is private: only its owner can load it. The toggle here is
 * the single thing that makes `/a/<publicId>` readable by anyone — the same
 * shape as ShareModal does for a whole conversation.
 */
export default function ArtifactShareModal() {
  const open = useStore((s) => s.artifactShareOpen);
  const busy = useStore((s) => s.artifactShareBusy);
  const error = useStore((s) => s.artifactShareError);
  const activeArtifact = useStore((s) => s.activeArtifact);
  // Subscribing to the record itself (not the getter) is what re-renders this
  // dialog when the toggle comes back from the server.
  const record = useStore((s) => s.artifactShare);
  const activeArtifactShare = useStore((s) => s.activeArtifactShare);
  const closeArtifactShare = useStore((s) => s.closeArtifactShare);
  const setActiveArtifactShared = useStore((s) => s.setActiveArtifactShared);

  const [copyState, setCopyState] = useState('idle'); // idle | copied | failed

  useEffect(() => {
    if (open) setCopyState('idle');
  }, [open]);

  useEffect(() => {
    if (copyState !== 'copied') return undefined;
    const timer = setTimeout(() => setCopyState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [copyState]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') closeArtifactShare();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeArtifactShare]);

  if (!open) return null;

  // `record` drives the render, but only once it describes the artifact on
  // screen — activeArtifactShare() is what checks that.
  const share = record && activeArtifactShare();
  const shared = Boolean(share?.shared);
  const url = share ? artifactUrl(share.publicId) : '';

  const handleCopy = async () => {
    if (!url) return;
    setCopyState((await copyToClipboard(url)) ? 'copied' : 'failed');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-surface-900 shadow-2xl shadow-black/60">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
          <div className="flex min-w-0 items-center gap-2">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-indigo-500/10">
              <Share2 size={16} className="text-indigo-400" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-zinc-100">Share this artifact</h2>
              <p className="truncate text-xs text-zinc-500">
                {share?.title || activeArtifact?.title || 'artifact'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={closeArtifactShare}
            className="rounded-lg p-1.5 text-zinc-500 hover:bg-white/5 hover:text-zinc-300"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-5 px-5 py-5">
          <p className="text-sm leading-relaxed text-zinc-300">
            This link opens the artifact on its own page — just the running app or
            graphic, with none of the chat around it. Turn sharing on and anyone
            with the link can open it, signed in or not.
          </p>

          <button
            type="button"
            onClick={() => setActiveArtifactShared(!shared)}
            disabled={busy || !share}
            className={clsx(
              'flex w-full items-center justify-between rounded-xl border px-4 py-3.5 text-left transition-colors disabled:opacity-60',
              shared
                ? 'border-emerald-500/30 bg-emerald-500/10'
                : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.06]'
            )}
          >
            <div className="flex items-center gap-3">
              <div
                className={clsx(
                  'grid h-9 w-9 place-items-center rounded-lg',
                  shared ? 'bg-emerald-500/15' : 'bg-zinc-700/50'
                )}
              >
                {shared ? (
                  <Globe size={17} className="text-emerald-400" />
                ) : (
                  <Lock size={17} className="text-zinc-400" />
                )}
              </div>
              <div>
                <div className="text-sm font-medium text-zinc-200">
                  {shared ? 'Public link' : 'Make this artifact public'}
                </div>
                <div className="text-xs text-zinc-500">
                  {shared
                    ? 'Anyone with the link can open it'
                    : 'Only you can open this link right now'}
                </div>
              </div>
            </div>
            <div
              className={clsx(
                'relative h-6 w-11 shrink-0 rounded-full transition-colors',
                shared ? 'bg-emerald-500' : 'bg-zinc-700'
              )}
            >
              <span
                className={clsx(
                  'absolute top-1 h-4 w-4 rounded-full bg-white transition-transform',
                  shared ? 'left-6' : 'left-1'
                )}
              />
            </div>
          </button>

          <div className="rounded-xl border border-white/10 px-4 py-3.5">
            <label className="mb-1.5 block text-xs font-medium text-zinc-500">
              {shared ? 'Public link' : 'Private link (only you can open it)'}
            </label>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={busy && !share ? 'Creating link…' : url}
                onFocus={(e) => e.target.select()}
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-300 outline-none"
              />
              <button
                type="button"
                onClick={handleCopy}
                disabled={!url || copyState === 'copied'}
                className={clsx(
                  'flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors disabled:opacity-50',
                  copyState === 'copied'
                    ? 'bg-emerald-500/15 text-emerald-300'
                    : copyState === 'failed'
                      ? 'bg-amber-500/15 text-amber-300'
                      : 'bg-indigo-500/15 text-indigo-300 hover:bg-indigo-500/25'
                )}
              >
                {copyState === 'copied' ? (
                  <>
                    <Check size={13} /> Copied
                  </>
                ) : copyState === 'failed' ? (
                  <>
                    <Link2 size={13} /> Failed
                  </>
                ) : (
                  <>
                    <Link2 size={13} /> Copy
                  </>
                )}
              </button>
              <a
                href={url || undefined}
                target="_blank"
                rel="noreferrer noopener"
                title="Open the artifact page"
                className={clsx(
                  'shrink-0 rounded-lg p-2 text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200',
                  !url && 'pointer-events-none opacity-40'
                )}
              >
                <ExternalLink size={14} />
              </a>
            </div>
          </div>

          {busy && (
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <Loader2 size={12} className="animate-spin" /> Saving…
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-300">
              {error}
            </div>
          )}

          <p className="text-xs leading-5 text-zinc-500">
            The link always shows this version of the artifact — editing it in the
            panel saves a new version with its own link.
            {shared && ' Turn sharing off and the link stops working for everyone else.'}
          </p>
        </div>
      </div>
    </div>
  );
}
