import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, FileText, Image as ImageIcon, Paperclip, Square, X, FileType } from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '../store/useStore.js';
import ModelPicker from './ModelPicker.jsx';

export default function Composer() {
  const {
    streaming,
    sendMessage,
    stopStreaming,
    companies,
    models,
    selectedModelId,
    selectedVisionModelId,
    currentId,
    conversations,
    setModel,
    setVisionModel,
    attachments,
    attachError,
    addAttachments,
    removeAttachment,
    openAttachment,
  } = useStore();
  const [value, setValue] = useState('');
  const textareaRef = useRef(null);
  const fileRef = useRef(null);

  const selectedModel = models.find((m) => m.id === selectedModelId);
  const currentConvo = conversations.find((c) => c._id === currentId);

  // Vision-capable models whose provider key is configured (these can read rendered PDF pages too).
  const visionChoices = useMemo(
    () =>
      models.filter(
        (m) => m.vision && companies.find((c) => c.id === m.company)?.available
      ),
    [models, companies]
  );
  // Trigger the file-model banner for any attachment type the chat model can't handle natively.
  const hasImages = attachments.some((a) => a.kind === 'image');
  const hasPdfs = attachments.some((a) => a.kind === 'pdf');
  const needsFileModel =
    (hasImages && selectedModel && !selectedModel.vision) ||
    (hasPdfs && selectedModel && !selectedModel.pdf);
  // Priority: saved on conversation > draft choice > first available vision model.
  const activeVisionModel =
    visionChoices.find((m) => m.id === (currentConvo?.visionModelId || selectedVisionModelId)) ||
    visionChoices[0] ||
    null;

  // Autofocus on mount and after each send.
  useEffect(() => {
    if (!streaming) textareaRef.current?.focus();
  }, [streaming]);

  const autosize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  const submit = () => {
    const text = value.trim();
    if ((!text && !attachments.length) || streaming) return;
    setValue('');
    requestAnimationFrame(() => {
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    });
    sendMessage(text); // attachments are pulled from the store
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-5 pt-2">
      <div className="rounded-3xl border border-white/10 bg-surface-850 shadow-xl shadow-black/40 transition-colors focus-within:border-indigo-500/40">
        {/* Attached image thumbnails + PDF chips */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 pt-3">
            {attachments.map((a, i) => {
              if (a.kind === 'pdf') {
                return (
                  <div
                    key={i}
                    className="group relative flex cursor-pointer items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] py-2 pl-2.5 pr-3 transition-colors hover:border-indigo-500/40 hover:bg-white/[0.07]"
                    onClick={() => openAttachment(a)}
                  >
                    <FileText size={15} className="shrink-0 text-rose-400/80" />
                    <span className="max-w-[140px] truncate text-xs text-zinc-300">{a.name}</span>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); removeAttachment(i); }}
                      className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-zinc-700 text-zinc-200 shadow hover:bg-rose-500"
                      title="Remove PDF"
                    >
                      <X size={11} />
                    </button>
                  </div>
                );
              }
              if (a.kind === 'doc') {
                return (
                  <div
                    key={i}
                    className="group relative flex cursor-pointer items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] py-2 pl-2.5 pr-3 transition-colors hover:border-indigo-500/40 hover:bg-white/[0.07]"
                    onClick={() => openAttachment(a)}
                  >
                    <FileType size={15} className="shrink-0 text-sky-400/80" />
                    <span className="max-w-[140px] truncate text-xs text-zinc-300">{a.name}</span>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); removeAttachment(i); }}
                      className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-zinc-700 text-zinc-200 shadow hover:bg-rose-500"
                      title="Remove document"
                    >
                      <X size={11} />
                    </button>
                  </div>
                );
              }
              return (
                <div key={i} className="group relative cursor-pointer" onClick={() => openAttachment(a)}>
                  <img
                    src={a.dataUrl}
                    alt={a.name || 'attachment'}
                    className="h-16 w-16 rounded-xl border border-white/10 object-cover transition-transform hover:scale-[1.04]"
                  />
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); removeAttachment(i); }}
                    className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-zinc-700 text-zinc-200 shadow hover:bg-rose-500"
                    title="Remove image"
                  >
                    <X size={11} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* File-model routing banner: chat model can't handle some attached file(s) */}
        {needsFileModel && (
          <div className="mx-4 mt-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] px-3.5 py-2.5 text-xs">
            {visionChoices.length ? (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                <span className="flex items-center gap-1.5 font-medium text-amber-300">
                  <ImageIcon size={13} />
                  {selectedModel.name} can't {hasImages && hasPdfs ? 'read these files' : hasImages ? 'see images' : 'read PDFs'}.
                </span>
                <span className="text-amber-200/70">{hasImages && hasPdfs ? 'Read with:' : hasImages ? 'See with:' : 'Read with:'}</span>
                <select
                  value={activeVisionModel?.id || ''}
                  onChange={(e) => setVisionModel(e.target.value)}
                  className="rounded-lg border border-amber-500/30 bg-surface-800 px-2 py-1 text-amber-100 outline-none"
                >
                  {visionChoices.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                      {m.price && m.price.in === 0 && m.price.out === 0 ? ' (free)' : ''}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => activeVisionModel && setModel(activeVisionModel.id)}
                  className="rounded-lg bg-amber-500/20 px-2.5 py-1 font-medium text-amber-200 transition-colors hover:bg-amber-500/30"
                  title={`Switch the whole chat to ${activeVisionModel?.name} (it handles both text + files natively)`}
                >
                  or switch chat to {activeVisionModel?.name}
                </button>
              </div>
            ) : (
              <span className="flex items-center gap-1.5 font-medium text-amber-300">
                <ImageIcon size={13} />
                {selectedModel.name} can't read the attached file(s) — add an API key for a vision model
                (e.g. Google, Z.ai, Moonshot) to read images and PDFs.
              </span>
            )}
          </div>
        )}

        {attachError && (
          <div className="mx-4 mt-3 rounded-xl border border-rose-500/25 bg-rose-500/[0.07] px-3.5 py-2 text-xs font-medium text-rose-300">
            {attachError}
          </div>
        )}

        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            autosize();
          }}
          onKeyDown={onKeyDown}
          placeholder={
            attachments.length
              ? 'Ask about the attached file(s)…'
              : 'Ask anything, or drag & drop images / PDFs / docs…'
          }
          className="max-h-[200px] w-full resize-none bg-transparent px-5 pb-2 pt-4 text-[15px] text-zinc-100 placeholder-zinc-500 outline-none"
        />
        <div className="flex items-center justify-between gap-2 px-3 pb-3">
          <div className="flex items-center gap-1.5">
            <ModelPicker compact />
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,.pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.doc,.docx"
              multiple
              className="hidden"
              onChange={(e) => {
                addAttachments(e.target.files || []);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              title="Attach images, PDFs or Word docs (or drag & drop anywhere)"
              className={clsx(
                'grid h-8 w-8 place-items-center rounded-full border transition-colors',
                attachments.length
                  ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300'
                  : 'border-white/10 bg-white/[0.04] text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200'
              )}
            >
              <Paperclip size={14} />
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden text-xs text-zinc-600 sm:block">
              Enter to send · Shift+Enter for newline
            </span>
            {streaming ? (
              <button
                type="button"
                onClick={stopStreaming}
                title="Stop generating"
                className="grid h-9 w-9 place-items-center rounded-full bg-zinc-700 text-zinc-100 transition-colors hover:bg-zinc-600"
              >
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!value.trim() && !attachments.length}
                title="Send"
                className={clsx(
                  'grid h-9 w-9 place-items-center rounded-full transition-all',
                  value.trim() || attachments.length
                    ? 'bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-lg shadow-indigo-600/30 hover:opacity-90'
                    : 'cursor-not-allowed bg-white/5 text-zinc-600'
                )}
              >
                <ArrowUp size={17} strokeWidth={2.5} />
              </button>
            )}
          </div>
        </div>
      </div>
      <p className="mt-2 text-center text-[11px] text-zinc-600">
        Models can make mistakes — verify important output. Add provider keys in{' '}
        <code className="rounded bg-white/5 px-1">server/.env</code> to unlock more models.
      </p>
    </div>
  );
}
