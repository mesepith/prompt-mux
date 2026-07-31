import { useEffect, useState } from 'react';
import { Check, Globe, Link2, Lock, Share2, X } from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '../store/useStore.js';
import { shareUrl } from '../lib/router.js';
import { copyToClipboard } from '../lib/clipboard.js';

export default function ShareModal() {
  const {
    shareModalOpen,
    closeShareModal,
    currentId,
    currentConversationShared,
    currentConversationIsOwner,
    setConversationShared,
    conversations,
  } = useStore();

  const convo = conversations.find((c) => c._id === currentId);
  const [copyState, setCopyState] = useState('idle'); // idle | copied | failed
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const url = currentId ? shareUrl(currentId) : '';
  const shared = currentConversationShared;
  const isOwner = currentConversationIsOwner;

  useEffect(() => {
    if (shareModalOpen) {
      setCopyState('idle');
      setError(null);
    }
  }, [shareModalOpen]);

  useEffect(() => {
    if (copyState !== 'copied') return undefined;
    const timer = setTimeout(() => setCopyState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [copyState]);

  if (!shareModalOpen || !currentId) return null;

  const handleCopy = async () => {
    const ok = await copyToClipboard(url);
    setCopyState(ok ? 'copied' : 'failed');
  };

  const toggleShared = async () => {
    if (!isOwner) return;
    setBusy(true);
    setError(null);
    try {
      await setConversationShared(!shared);
    } catch (err) {
      setError(err?.message || 'Could not update sharing');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-surface-900 shadow-2xl shadow-black/60">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
          <div className="flex items-center gap-2">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-indigo-500/10">
              <Share2 size={16} className="text-indigo-400" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-zinc-100">Share this chat</h2>
              <p className="text-xs text-zinc-500">{convo?.title || 'Untitled chat'}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={closeShareModal}
            className="rounded-lg p-1.5 text-zinc-500 hover:bg-white/5 hover:text-zinc-300"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-5 px-5 py-5">
          <p className="text-sm leading-relaxed text-zinc-300">
            Anyone with this link can view the full conversation — no login required.
            They can’t edit or delete anything you wrote, but they can send a message
            to continue the discussion in their own copy.
          </p>

          {isOwner && (
            <button
              type="button"
              onClick={toggleShared}
              disabled={busy}
              className={clsx(
                'flex w-full items-center justify-between rounded-xl border px-4 py-3.5 text-left transition-colors',
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
                    {shared ? 'Sharing is on' : 'Make this chat shareable'}
                  </div>
                  <div className="text-xs text-zinc-500">
                    {shared
                      ? 'Anyone with the link can view it'
                      : 'Only you can open this link right now'}
                  </div>
                </div>
              </div>
              <div
                className={clsx(
                  'relative h-6 w-11 rounded-full transition-colors',
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
          )}

          {!isOwner && (
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-300">
              You’re viewing a shared chat. Sending a message will create your own
              private copy.
            </div>
          )}

          <div className={clsx('rounded-xl border px-4 py-3.5', shared ? 'border-white/10' : 'border-white/10 bg-white/[0.02]')}>
            <label className="mb-1.5 block text-xs font-medium text-zinc-500">
              {shared ? 'Share link' : 'Private link (only you can use it)'}
            </label>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={url}
                onFocus={(e) => e.target.select()}
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-300 outline-none"
              />
              <button
                type="button"
                onClick={handleCopy}
                disabled={copyState === 'copied'}
                className={clsx(
                  'flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors',
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
                    <Link2 size={13} /> Copy link
                  </>
                )}
              </button>
            </div>
          </div>

          {error && (
            <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-300">
              {error}
            </div>
          )}

          <p className="text-xs leading-5 text-zinc-500">
            Only share links to conversations you’re comfortable making public.
            {shared && (
              <>
                {' '}
                You can turn sharing off anytime — the link will stop working for
                anyone who refreshes the page.
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
