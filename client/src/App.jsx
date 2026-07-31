import { useEffect, useState } from 'react';
import { Globe, Link2, PanelLeft, Pencil, X, Zap } from 'lucide-react';
import clsx from 'clsx';
import { useStore } from './store/useStore.js';
import { formatCost, formatTokens, messageCost } from './lib/usage.js';
import { onRouteChange } from './lib/router.js';
import Sidebar from './components/Sidebar.jsx';
import MessageList from './components/MessageList.jsx';
import Composer from './components/Composer.jsx';
import EmptyState from './components/EmptyState.jsx';
import ArtifactPanel from './components/ArtifactPanel.jsx';
import DropZone from './components/DropZone.jsx';
import AttachmentViewer from './components/AttachmentViewer.jsx';
import AuthModal from './components/AuthModal.jsx';
import ShareModal from './components/ShareModal.jsx';

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

function ShareLinkButton() {
  const currentId = useStore((s) => s.currentId);
  const openShareModal = useStore((s) => s.openShareModal);
  const shared = useStore((s) => s.currentConversationShared);

  if (!currentId) return null;

  return (
    <button
      type="button"
      onClick={openShareModal}
      title="Share this chat"
      className={clsx(
        'flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-medium transition-colors',
        shared
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
          : 'border-white/[0.07] bg-white/[0.03] text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-200'
      )}
    >
      {shared ? <Globe size={12} /> : <Link2 size={12} />}
      {shared ? 'Shared' : 'Share link'}
    </button>
  );
}

function TopBar() {
  const { currentId, conversations, renameConversation, toggleSidebar, currentConversationIsOwner } = useStore();
  const convo = conversations.find((c) => c._id === currentId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const isOwner = currentConversationIsOwner;

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
            title={isOwner ? 'Rename chat' : 'Shared chat — only the owner can rename'}
            onClick={() => {
              if (!isOwner) return;
              setDraft(convo.title);
              setEditing(true);
            }}
            className={clsx(
              'group flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5',
              isOwner && 'hover:bg-white/5'
            )}
          >
            <span className="truncate text-sm font-medium text-zinc-200">{convo.title}</span>
            {isOwner && (
              <Pencil size={12} className="shrink-0 text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100" />
            )}
          </button>
        )
      ) : (
        <span className="text-sm text-zinc-500">New conversation</span>
      )}

      <div className="ml-auto flex items-center gap-2">
        <ShareLinkButton />
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
  const currentConversationIsOwner = useStore((s) => s.currentConversationIsOwner);
  const currentConversationShared = useStore((s) => s.currentConversationShared);

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
        {currentConversationShared && !currentConversationIsOwner && (
          <div className="flex items-center justify-center gap-2 border-b border-sky-500/20 bg-sky-500/10 px-4 py-2 text-xs text-sky-300">
            <Globe size={13} />
            <span>
              You’re viewing a shared chat. Send a message to create your own private copy
              and continue the conversation.
            </span>
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
      <ShareModal />
    </div>
  );
}
