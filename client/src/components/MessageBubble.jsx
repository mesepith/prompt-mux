import { AlertTriangle, FileText, FileType, MousePointerClick, Play } from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '../store/useStore.js';
import { extractArtifacts } from '../lib/artifacts.js';
import Markdown from './Markdown.jsx';
import MessageMeta from './MessageMeta.jsx';

function ArtifactCard({ artifact }) {
  const { openArtifact } = useStore();
  return (
    <button
      type="button"
      onClick={() => openArtifact(artifact)}
      className="group mt-4 flex w-full items-center gap-3 rounded-xl border border-indigo-500/25 bg-gradient-to-r from-indigo-500/10 to-violet-500/10 px-4 py-3 text-left transition-all hover:border-indigo-500/50 hover:from-indigo-500/15 hover:to-violet-500/15"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-md shadow-indigo-900/50">
        <Play size={14} fill="currentColor" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-zinc-100">
          {artifact.title}
        </span>
        <span className="block text-xs text-zinc-500">
          Interactive {artifact.language.toUpperCase()} artifact — click to preview
        </span>
      </span>
      <span className="shrink-0 rounded-md bg-white/5 px-2 py-1 font-mono text-[10px] uppercase text-zinc-500 group-hover:text-zinc-300">
        {artifact.language}
      </span>
    </button>
  );
}

export default function MessageBubble({ message, isStreaming = false }) {
  const statusText = useStore((s) => s.statusText);
  const openAttachment = useStore((s) => s.openAttachment);
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <div className="flex justify-end animate-fade-in">
        <div className="max-w-[80%]">
          {message.attachments?.length > 0 && (
            <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
              {message.attachments.map((a, i) => {
                if (a.kind === 'pdf') {
                  const hasText = (a.textContent || '')
                    .replace(/--- Page \d+ ---/g, '')
                    .trim().length > 0;
                  const state = a.scanned
                    ? { label: 'read via image model', style: 'bg-emerald-500/15', icon: 'text-emerald-400', tip: 'No text layer — contents were read from page images by a vision model' }
                    : hasText
                      ? { label: 'text extracted', style: 'bg-rose-500/15', icon: 'text-rose-400', tip: `${((a.textContent || '').length / 1000).toFixed(0)}k chars extracted` }
                      : { label: 'no text — likely scanned', style: 'bg-amber-500/15', icon: 'text-amber-400', tip: 'No text layer found and no vision model was available to read it' };
                  return (
                    <button
                      type="button"
                      key={i}
                      onClick={() => openAttachment(a)}
                      className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.05] px-3.5 py-2.5 transition-colors hover:border-indigo-500/40 hover:bg-white/[0.08]"
                      title={state.tip}
                    >
                      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${state.style}`}>
                        <FileText size={16} className={state.icon} />
                      </span>
                      <span>
                        <span className="block max-w-[200px] truncate text-sm font-medium text-zinc-200">
                          {a.name || 'document.pdf'}
                        </span>
                        <span className="block text-[11px] text-zinc-500">
                          PDF{a.pageCount ? ` · ${a.pageCount} page${a.pageCount === 1 ? '' : 's'}` : ''}
                          {` · ${state.label}`}
                        </span>
                      </span>
                    </button>
                  );
                }
                if (a.kind === 'doc') {
                  return (
                    <button
                      type="button"
                      key={i}
                      onClick={() => openAttachment(a)}
                      className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.05] px-3.5 py-2.5 transition-colors hover:border-indigo-500/40 hover:bg-white/[0.08]"
                      title="Word document — click to view"
                    >
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-sky-500/15">
                        <FileType size={16} className="text-sky-400" />
                      </span>
                      <span>
                        <span className="block max-w-[200px] truncate text-sm font-medium text-zinc-200">
                          {a.name || 'document.docx'}
                        </span>
                        <span className="block text-[11px] text-zinc-500">
                          Word doc · converted to HTML
                        </span>
                      </span>
                    </button>
                  );
                }
                return (
                  <button
                    type="button"
                    key={i}
                    onClick={() => openAttachment(a)}
                    title="View image"
                    className="block transition-transform hover:scale-[1.02]"
                  >
                    <img
                      src={a.dataUrl}
                      alt={a.name || 'attached image'}
                      className="max-h-44 rounded-xl border border-white/10 object-cover shadow-md"
                    />
                  </button>
                );
              })}
            </div>
          )}
          {message.content && (
            <div className="whitespace-pre-wrap rounded-2xl rounded-br-md bg-gradient-to-br from-violet-600 to-indigo-600 px-4 py-2.5 text-[15px] leading-7 text-white shadow-md shadow-indigo-950/40">
              {message.content}
            </div>
          )}
        </div>
      </div>
    );
  }

  const artifacts = isStreaming ? [] : extractArtifacts(message.content, message._id);
  const edit = message.artifactEdit?.instruction ? message.artifactEdit : null;

  return (
    <div className="animate-fade-in">
      {edit && (
        <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-violet-400/25 bg-violet-500/[0.08] px-2.5 py-1 text-[11px] font-medium text-violet-300">
          <MousePointerClick size={11} />
          Targeted edit
          {edit.target && <code className="font-mono text-violet-200/80">{edit.target}</code>}
        </div>
      )}
      {message.error ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-rose-500/25 bg-rose-500/[0.07] px-4 py-3">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-rose-400" />
          <div>
            <div className="text-sm font-semibold text-rose-300">Generation failed</div>
            <div className="text-sm text-rose-200/70">{message.error}</div>
          </div>
        </div>
      ) : (
        <div className={clsx(isStreaming && message.content && 'stream-cursor')}>
          {message.content ? (
            <Markdown content={message.content} />
          ) : isStreaming ? (
            <span className="inline-flex gap-1 py-2">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-500"
                  style={{ animationDelay: `${i * 150}ms` }}
                />
              ))}
            </span>
          ) : null}
        </div>
      )}

      {artifacts.map((a, i) => (
        <ArtifactCard key={`${a.title}-${i}`} artifact={a} />
      ))}

      {/* Pipeline status, e.g. "Analyzing image with GLM-4.6V…" */}
      {isStreaming && statusText && (
        <div className="mt-2.5 inline-flex items-center gap-2 rounded-full border border-amber-500/20 bg-amber-500/[0.06] px-3 py-1.5 text-[11px] font-medium text-amber-300/90">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
          {statusText}
        </div>
      )}

      {/* Model + token usage + cost footer */}
      <MessageMeta message={message} isStreaming={isStreaming} />
    </div>
  );
}
