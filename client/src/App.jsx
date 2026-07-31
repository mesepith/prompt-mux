import { useEffect, useState } from 'react';
import { Check, Link2, PanelLeft, Pencil, X, Zap } from 'lucide-react';
import clsx from 'clsx';
import { useStore } from './store/useStore.js';
import { formatCost, formatTokens, messageCost } from './lib/usage.js';
import { onRouteChange, shareUrl } from './lib/router.js';
import { copyToClipboard } from './lib/clipboard.js';
import Sidebar from './components/Sidebar.jsx';
import MessageList from './components/MessageList.jsx';
import Composer from './components/Composer.jsx';
import EmptyState from './components/EmptyState.jsx';
import ArtifactPanel from './components/ArtifactPanel.jsx';
import DropZone from './components/DropZone.jsx';
import AttachmentViewer from './components/AttachmentViewer.jsx';
import AuthModal from './components/AuthModal.jsx';

function SessionUsage() {
  const { messages, modelById } = useStore();
  let input = 0;
  let output = 0;
  let cost = 0;
  let priced = false;
  for (const m of messages) {
    if (!m.usage) continue;
    input += m.usage.inputTokens || 0;
    output += m.usage.outputTokens || 0;
    const c = messageCost(m.usage, modelById(m.modelId));
    if (c != null) {
      cost += c;
      priced = true;
    }
  }
  const total = input + output;
  if (!total) return null;
  return (
    <div
      className="flex cursor-default items-center gap-1.5 rounded-full border border-white/[0.07] bg-white/[0.03] px-3 py-1.5 text-[11px] font-medium tabular-nums text-zinc-400"
      title={`This chat: ${input.toLocaleString()} in + ${output.toLocaleString()} out${
        priced ? ` · est. ${formatCost(cost)}` : ''
      }`}
    >
      <Zap size={11} className="text-amber-400/80" />
      {formatTokens(total)} tok
      {priced && <span className="border-l border-white/10 pl-1.5 font-semibold text-emerald-400/90">{formatCost(cost)}</span>}
    </div>
  );
}

// Every saved chat lives at /c/<id> — this copies that link for sharing or
// bookmarking. The address bar already shows it; this is the one-click version.
function ShareLink() {
  const currentId = useStore((s) => s.currentId);
  const [state, setState] = useState('idle'); // idle | copied | failed

  // "Copied" is transient feedback; "failed" sticks around because it exposes
  // the URL for manual copying (some browsers block clipboard writes).
  useEffect(() => {
    if (state !== 'copied') return undefined;
    const timer = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [state]);

  useEffect(() => setState('idle'), [currentId]);

  if (!currentId) return null;
  const url = shareUrl(currentId);

  return (
    <>
      {state === 'failed' && (
        <input
          readOnly
          autoFocus
          value={url}
          onFocus={(e) => e.target.select()}
          className="w-64 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-zinc-300 outline-none"
        />
      )}
      <button
        type="button"
        onClick={async () => setState((await copyToClipboard(url)) ? 'copied' : 'failed')}
        title={state === 'failed' ? `Copy it manually: ${url}` : `Copy link to this chat\n${url}`}
        className={clsx(
          'flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-medium transition-colors',
          state === 'copied'
            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
            : state === 'failed'
              ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
              : 'border-white/[0.07] bg-white/[0.03] text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-200'
        )}
      >
        {state === 'copied' ? <Check size={12} /> : <Link2 size={12} />}
        {state === 'copied' ? 'Link copied' : state === 'failed' ? 'Copy manually' : 'Share link'}
      </button>
    </>
  );
}

function TopBar() {
  const { currentId, conversations, renameConversation, toggleSidebar } = useStore();
  const convo = conversations.find((c) => c._id === currentId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const commit = () => {
    const title = draft.trim();
    if (title && convo && title !== convo.title) renameConversation(convo._id, title);
    setEditing(false);
  };

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-white/[0.06] bg-surface-950/80 px-3 backdrop-blur">
      <button
        type="button"
        onClick={toggleSidebar}
        title="Toggle sidebar"
        className="rounded-lg p-2 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
      >
        <PanelLeft size={17} />
      </button>

      {convo ? (
        editing ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
                if (e.key === 'Escape') setEditing(false);
              }}
              className="w-full max-w-md rounded-lg border border-indigo-500/40 bg-white/5 px-2.5 py-1.5 text-sm text-zinc-100 outline-none"
            />
            <button type="button" onClick={commit} className="rounded-lg p-1.5 text-emerald-400 hover:bg-white/5">
              <Check size={15} />
            </button>
            <button type="button" onClick={() => setEditing(false)} className="rounded-lg p-1.5 text-zinc-500 hover:bg-white/5">
              <X size={15} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            title="Rename chat"
            onClick={() => {
              setDraft(convo.title);
              setEditing(true);
            }}
            className="group flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5"
          >
            <span className="truncate text-sm font-medium text-zinc-200">{convo.title}</span>
            <Pencil size={12} className="shrink-0 text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        )
      ) : (
        <span className="text-sm text-zinc-500">New conversation</span>
      )}

      <div className="ml-auto flex items-center gap-2">
        <ShareLink />
        <SessionUsage />
      </div>
    </header>
  );
}

function Splash() {
  return (
    <div className="grid h-screen place-items-center bg-surface-950">
      <div className="flex flex-col items-center gap-4">
        <img src="/logo.svg" alt="PromptMux" className="h-14 w-14 animate-pulse rounded-2xl" />
        <div className="text-sm text-zinc-500">Loading PromptMux…</div>
      </div>
    </div>
  );
}

export default function App() {
  const { bootstrap, booted, bootError, messages, activeArtifact } = useStore();
  const activeAttachment = useStore((s) => s.activeAttachment);
  const linkError = useStore((s) => s.linkError);
  const dismissLinkError = useStore((s) => s.dismissLinkError);
  const handleRouteChange = useStore((s) => s.handleRouteChange);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  // Browser Back/Forward between chats.
  useEffect(() => onRouteChange(handleRouteChange), [handleRouteChange]);

  if (!booted) return <Splash />;

  return (
    <div className="flex h-screen overflow-hidden bg-surface-950">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        {bootError && (
          <div className="border-b border-rose-500/20 bg-rose-500/10 px-4 py-2 text-center text-xs text-rose-300">
            {bootError} — is the server running on port 5050?
          </div>
        )}
        {linkError && (
          <div className="flex items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs text-amber-300">
            <span className="flex-1 text-center">{linkError}</span>
            <button
              type="button"
              onClick={dismissLinkError}
              title="Dismiss"
              className="rounded p-0.5 text-amber-300/70 hover:text-amber-200"
            >
              <X size={13} />
            </button>
          </div>
        )}
        <div className="relative flex min-h-0 flex-1">
          <DropZone>
            {messages.length === 0 ? <EmptyState /> : <MessageList />}
            <Composer />
          </DropZone>
          {activeArtifact && <ArtifactPanel />}
        </div>
      </main>
      <AttachmentViewer key={activeAttachment?.dataUrl?.slice(-12) || 'none'} />
      <AuthModal />
    </div>
  );
}
