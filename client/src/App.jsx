import { useEffect, useState } from 'react';
import { Check, PanelLeft, Pencil, X, Zap } from 'lucide-react';
import { useStore } from './store/useStore.js';
import { formatCost, formatTokens, messageCost } from './lib/usage.js';
import Sidebar from './components/Sidebar.jsx';
import MessageList from './components/MessageList.jsx';
import Composer from './components/Composer.jsx';
import EmptyState from './components/EmptyState.jsx';
import ArtifactPanel from './components/ArtifactPanel.jsx';
import DropZone from './components/DropZone.jsx';
import AttachmentViewer from './components/AttachmentViewer.jsx';

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
      className="ml-auto flex cursor-default items-center gap-1.5 rounded-full border border-white/[0.07] bg-white/[0.03] px-3 py-1.5 text-[11px] font-medium tabular-nums text-zinc-400"
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

      <SessionUsage />
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

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

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
        <div className="relative flex min-h-0 flex-1">
          <DropZone>
            {messages.length === 0 ? <EmptyState /> : <MessageList />}
            <Composer />
          </DropZone>
          {activeArtifact && <ArtifactPanel />}
        </div>
      </main>
      <AttachmentViewer key={activeAttachment?.dataUrl?.slice(-12) || 'none'} />
    </div>
  );
}
