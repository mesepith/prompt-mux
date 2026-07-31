import { MessageSquare, Plus, Trash2, X } from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '../store/useStore.js';
import { timeAgo } from '../lib/artifacts.js';
import { conversationPath } from '../lib/router.js';
import AuthButton from './AuthButton.jsx';

export default function Sidebar() {
  const {
    conversations,
    currentId,
    currentConversationIsOwner,
    selectConversation,
    newChat,
    deleteConversation,
    sidebarOpen,
    toggleSidebar,
    companies,
    models,
  } = useStore();

  const availableCount = companies.filter((c) => c.available).length;

  return (
    <>
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          onClick={toggleSidebar}
        />
      )}

      <aside
        className={clsx(
          'z-40 flex h-full w-72 shrink-0 flex-col border-r border-white/[0.06] bg-surface-900 transition-transform duration-200',
          'fixed inset-y-0 left-0 lg:static lg:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:hidden'
        )}
      >
        {/* Brand */}
        <div className="flex items-center gap-2.5 px-4 pb-2 pt-4">
          <img src="/logo.svg" alt="PromptMux" className="h-8 w-8 rounded-lg" />
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-bold tracking-tight text-zinc-50">PromptMux</div>
            <div className="truncate text-[11px] text-zinc-500">every model, one chat</div>
          </div>
          <button
            type="button"
            onClick={toggleSidebar}
            className="rounded-lg p-1.5 text-zinc-500 hover:bg-white/5 hover:text-zinc-300 lg:hidden"
          >
            <X size={16} />
          </button>
        </div>

        {/* New chat */}
        <div className="px-3 pb-2 pt-2">
          <button
            type="button"
            onClick={newChat}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-900/40 transition-opacity hover:opacity-90"
          >
            <Plus size={16} strokeWidth={2.5} />
            New chat
          </button>
        </div>

        {/* Conversation list */}
        <div className="mt-1 flex-1 overflow-y-auto px-3 pb-3">
          {conversations.length > 0 && (
            <div className="px-2 pb-1.5 pt-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-600">
              Recent
            </div>
          )}
          <div className="space-y-0.5">
            {conversations.map((c) => (
              <div
                key={c._id}
                className={clsx(
                  'group flex items-center gap-2 rounded-xl px-3 py-2.5 transition-colors',
                  c._id === currentId
                    ? 'bg-white/[0.08] text-zinc-100'
                    : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200'
                )}
              >
                {/* A real <a> so chats can be copied as links, middle-clicked or
                    ⌘/ctrl-clicked into a new tab; plain clicks stay client-side. */}
                <a
                  href={conversationPath(c._id)}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2"
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                    e.preventDefault();
                    selectConversation(c._id);
                    if (window.innerWidth < 1024) toggleSidebar();
                  }}
                >
                  <MessageSquare size={14} className="shrink-0 text-zinc-600" />
                  <span className="min-w-0 flex-1 truncate text-sm">{c.title}</span>
                  <span className="shrink-0 text-[10px] text-zinc-600 group-hover:hidden">
                    {timeAgo(c.lastMessageAt)}
                  </span>
                </a>
                {(c._id !== currentId || currentConversationIsOwner) && (
                  <button
                    type="button"
                    title="Delete chat"
                    className="hidden shrink-0 rounded p-0.5 text-zinc-500 hover:text-rose-400 group-hover:block"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteConversation(c._id);
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            ))}
            {conversations.length === 0 && (
              <p className="px-3 pt-6 text-center text-xs leading-5 text-zinc-600">
                No chats yet.
                <br />
                Start one — pick any model.
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-white/[0.06] px-4 py-3">
          <div className="mb-3">
            <AuthButton />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {companies.map((c) => (
              <span
                key={c.id}
                title={`${c.name}: ${c.available ? 'ready' : 'add API key'}`}
                className="flex items-center gap-1 rounded-full bg-white/[0.04] px-2 py-1 text-[10px] text-zinc-500"
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: c.available ? c.color : '#3f3f46' }}
                />
                {c.name.replace(' (no key needed)', '')}
              </span>
            ))}
          </div>
          <p className="mt-2 text-[10px] text-zinc-600">
            {models.length} models · {availableCount}/{companies.length} providers ready
          </p>
        </div>
      </aside>
    </>
  );
}
