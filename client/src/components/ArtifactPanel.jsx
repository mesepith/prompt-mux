import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  Check,
  Code2,
  Copy,
  CornerDownLeft,
  ExternalLink,
  Eye,
  Loader2,
  MousePointerClick,
  Wand2,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '../store/useStore.js';
import { buildPreviewDoc, openArtifactInNewTab } from '../lib/artifacts.js';
import { scanHtmlNodes } from '../lib/htmlNodes.js';

const PARENT_SOURCE = 'promptmux';
const PREVIEW_SOURCE = 'promptmux-preview';
const CARD_WIDTH = 360;
const CARD_HEIGHT = 190; // estimate, only used to flip the card above/below

const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

/** Cheap stable hash so the iframe remounts whenever the document changes. */
function hash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h;
}

const finite = (value) => (Number.isFinite(value) ? value : 0);

/**
 * The preview document runs the model's JS next to our picker runtime, so a
 * hostile artifact can post a forged "selected" message. Everything that could
 * mislead the user about what they're editing — the id, the label, the ancestor
 * chain — is therefore re-derived from our own scan of the source; only the
 * geometry and the text preview come from the frame.
 */
function sanitizeSelection(node, nodes) {
  if (!node || !Number.isInteger(node.id) || node.id < 0) return null;
  const source = nodes[node.id];
  if (!source || !source.pickable) return null;
  if (typeof node.tag === 'string' && node.tag.toLowerCase() !== source.tag) return null;
  const rect = node.rect || {};
  return {
    id: node.id,
    label: source.label,
    text: typeof node.text === 'string' ? node.text.slice(0, 120) : '',
    rect: {
      left: finite(rect.left),
      top: finite(rect.top),
      width: finite(rect.width),
      height: finite(rect.height),
    },
    ancestors: (Array.isArray(node.ancestors) ? node.ancestors : [])
      .filter((a) => a && Number.isInteger(a.id) && nodes[a.id]?.pickable)
      .slice(0, 12)
      .map((a) => ({ id: a.id, label: nodes[a.id].label })),
  };
}

/**
 * Claude-Artifacts style side panel: live sandboxed preview + source view.
 * The iframe is sandboxed with only allow-scripts — no same-origin access.
 *
 * "Point & edit" (the crosshair button) lets the user click one part of the
 * preview and describe a change for just that part: the preview copy is stamped
 * with data-pm-node ids (lib/htmlNodes.js), the injected runtime
 * (lib/pickerScript.js) reports which id was clicked over postMessage, and the
 * edit replaces only that element's source range — the model is never asked to
 * regenerate the whole document.
 */
export default function ArtifactPanel() {
  const activeArtifact = useStore((s) => s.activeArtifact);
  const messages = useStore((s) => s.messages);
  const currentConversationIsOwner = useStore((s) => s.currentConversationIsOwner);
  const closeArtifact = useStore((s) => s.closeArtifact);
  const editArtifactElement = useStore((s) => s.editArtifactElement);
  const clearArtifactEditFeedback = useStore((s) => s.clearArtifactEditFeedback);
  const busy = useStore((s) => s.artifactEditBusy);
  const editError = useStore((s) => s.artifactEditError);
  const editNote = useStore((s) => s.artifactEditNote);

  const [tab, setTab] = useState('preview');
  const [copied, setCopied] = useState(false);
  const [picking, setPicking] = useState(false);
  const [selection, setSelection] = useState(null); // { id, label, text, rect, ancestors }
  const [instruction, setInstruction] = useState('');
  const [localError, setLocalError] = useState(null);
  const iframeRef = useRef(null);

  const code = activeArtifact?.code || '';
  // The preview always carries the picker runtime (dormant until enabled) so
  // entering edit mode never reloads the artifact and throws away its state.
  const doc = useMemo(() => buildPreviewDoc(activeArtifact, { picker: true }), [activeArtifact]);
  const nodes = useMemo(() => scanHtmlNodes(code), [code]);
  const docKey = useMemo(() => hash(doc), [doc]);
  const savedArtifact = Boolean(activeArtifact?.messageId);

  // Editing an artifact opened from further up the transcript is legal, but it
  // branches from that older version — worth saying so before the user applies.
  const isOldVersion = useMemo(() => {
    if (!activeArtifact?.messageId) return false;
    const newest = [...messages].reverse().find((m) => /```(html|svg)\s*\n/.test(m.content || ''));
    return Boolean(newest && newest._id !== activeArtifact.messageId);
  }, [messages, activeArtifact?.messageId]);

  const post = useCallback((payload) => {
    const target = iframeRef.current?.contentWindow;
    if (!target) return;
    target.postMessage({ source: PARENT_SOURCE, ...payload }, '*');
  }, []);

  // Preview -> panel messages. The sandbox gives the frame an opaque origin, so
  // identity is its contentWindow, not event.origin.
  useEffect(() => {
    const onMessage = (event) => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      const data = event.data;
      if (!data || data.source !== PREVIEW_SOURCE) return;
      if (data.type === 'ready') {
        post({ type: 'picker', enabled: picking });
      } else if (data.type === 'selected') {
        const node = sanitizeSelection(data.node, nodes);
        if (!node) return;
        setLocalError(null);
        // Read fresh state instead of subscribing: a frame that floods messages
        // then can't force a store write (and re-render) per message.
        const { artifactEditError, artifactEditNote } = useStore.getState();
        if (artifactEditError || artifactEditNote) clearArtifactEditFeedback();
        setSelection((prev) =>
          prev && JSON.stringify(prev) === JSON.stringify(node) ? prev : node
        );
      } else if (data.type === 'rect') {
        const rect = data.rect || {};
        setSelection((s) =>
          s && s.id === data.id
            ? {
                ...s,
                rect: {
                  left: finite(rect.left),
                  top: finite(rect.top),
                  width: finite(rect.width),
                  height: finite(rect.height),
                },
              }
            : s
        );
      } else if (data.type === 'cleared') {
        setSelection(null);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [picking, post, clearArtifactEditFeedback, nodes]);

  // Keep the preview's mode in sync with the toggle.
  useEffect(() => {
    post({ type: 'picker', enabled: picking });
    if (!picking) {
      post({ type: 'select', id: null });
      setSelection(null);
      setInstruction('');
      setLocalError(null);
    }
  }, [picking, post]);

  // A new artifact version (or a different artifact) invalidates the selection.
  useEffect(() => {
    setSelection(null);
    setInstruction('');
    setLocalError(null);
  }, [code]);

  // Esc drops the selection first, then leaves edit mode.
  useEffect(() => {
    if (!picking) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (selection) {
        setSelection(null);
        post({ type: 'select', id: null });
      } else {
        setPicking(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picking, selection, post]);

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

  const clearSelection = () => {
    setSelection(null);
    post({ type: 'select', id: null });
  };

  const apply = async () => {
    const text = instruction.trim();
    if (!text || !selection || busy) return;
    const node = nodes[selection.id];
    if (!node) {
      setLocalError('That selection is stale — click the element again.');
      return;
    }
    const result = await editArtifactElement({
      start: node.start,
      end: node.end,
      snippet: code.slice(node.start, node.end),
      instruction: text,
      targetLabel: selection.label,
    });
    // When the model changed nothing the artifact — and so every node id — is
    // unchanged, so keep the selection and the typed instruction for a reword.
    if (result.ok && !result.unchanged) {
      setInstruction('');
      clearSelection();
    }
  };

  // Anchor the edit card next to the selected element (viewport coordinates).
  let cardStyle = null;
  if (picking && selection) {
    const frame = iframeRef.current?.getBoundingClientRect();
    if (frame) {
      const rect = selection.rect || { left: 0, top: 0, width: 0, height: 0 };
      const cardWidth = Math.min(CARD_WIDTH, frame.width - 16);
      const left = clamp(frame.left + rect.left, frame.left + 8, frame.right - cardWidth - 8);
      const below = frame.top + rect.top + rect.height + 10;
      const fitsBelow = below + CARD_HEIGHT < window.innerHeight - 8;
      const top = fitsBelow
        ? below
        : clamp(frame.top + rect.top - CARD_HEIGHT - 10, 8, window.innerHeight - CARD_HEIGHT - 8);
      cardStyle = { left, top, width: cardWidth };
    }
  }

  const feedback = localError || editError || editNote;
  const feedbackTone = localError || editError ? 'text-rose-300' : 'text-amber-300';

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
          title={
            !currentConversationIsOwner
              ? 'Only the chat owner can edit artifacts'
              : savedArtifact
                ? 'Point & edit — click a part of the preview and describe the change'
                : 'Point & edit becomes available once the reply is saved'
          }
          disabled={!savedArtifact || !currentConversationIsOwner}
          onClick={() => {
            setTab('preview');
            setPicking((v) => !v);
          }}
          className={clsx(
            'rounded-lg p-2 transition-colors',
            !savedArtifact
              ? 'cursor-not-allowed text-zinc-700'
              : picking
                ? 'bg-violet-500/20 text-violet-300'
                : 'text-zinc-500 hover:bg-white/5 hover:text-zinc-200'
          )}
        >
          <MousePointerClick size={15} />
        </button>
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
      <div className="relative min-h-0 flex-1">
        {tab === 'preview' ? (
          <>
            <iframe
              ref={iframeRef}
              key={docKey}
              title={activeArtifact.title}
              sandbox="allow-scripts"
              srcDoc={doc}
              className="h-full w-full border-0 bg-white"
            />
            {picking && (
              <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-2">
                <div className="flex items-center gap-2 rounded-full border border-violet-400/30 bg-surface-950/90 px-3 py-1.5 text-[11px] font-medium text-violet-200 shadow-lg backdrop-blur">
                  <MousePointerClick size={12} />
                  {selection
                    ? 'Describe the change for the highlighted part'
                    : 'Click any part of the preview to edit just that part'}
                  <span className="text-zinc-500">· Esc</span>
                </div>
              </div>
            )}
          </>
        ) : (
          <pre className="h-full overflow-auto p-4 font-mono text-[12.5px] leading-5 text-zinc-300">
            {activeArtifact.code}
          </pre>
        )}

        {/* Feedback with no card to put it in (edit applied, or it failed after
            the card closed) — the note would otherwise never be seen. */}
        {!cardStyle && feedback && (
          <button
            type="button"
            title="Dismiss"
            onClick={() => {
              setLocalError(null);
              clearArtifactEditFeedback();
            }}
            className={clsx(
              'absolute inset-x-0 bottom-3 mx-auto flex w-fit max-w-[92%] items-center gap-2 rounded-full border px-3 py-1.5 text-left text-[11px] shadow-lg backdrop-blur',
              localError || editError
                ? 'border-rose-500/30 bg-rose-500/15 text-rose-200'
                : 'border-amber-500/30 bg-amber-500/15 text-amber-200'
            )}
          >
            {feedback}
            <X size={11} className="shrink-0 opacity-70" />
          </button>
        )}
      </div>

      {/* Inline edit card, anchored to the selected element */}
      {cardStyle && (
        <div
          style={cardStyle}
          className="fixed z-50 overflow-hidden rounded-2xl border border-violet-400/30 bg-surface-850/95 shadow-2xl shadow-black/60 backdrop-blur"
        >
          <div className="flex items-center gap-2 border-b border-white/[0.07] px-3 py-2">
            <span className="shrink-0 truncate rounded-md bg-violet-500/15 px-2 py-0.5 font-mono text-[11px] text-violet-200">
              {selection.label}
            </span>
            {selection.text && (
              <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-500">
                “{selection.text}”
              </span>
            )}
            {selection.ancestors?.length > 0 && (
              <button
                type="button"
                onClick={() => post({ type: 'select', id: selection.ancestors[0].id })}
                title={`Select parent (${selection.ancestors[0].label})`}
                className="ml-auto shrink-0 rounded-md p-1 text-zinc-500 hover:bg-white/5 hover:text-zinc-200"
              >
                <ArrowUp size={13} />
              </button>
            )}
            <button
              type="button"
              onClick={clearSelection}
              title="Cancel"
              className="shrink-0 rounded-md p-1 text-zinc-500 hover:bg-white/5 hover:text-zinc-200"
            >
              <X size={13} />
            </button>
          </div>

          <textarea
            autoFocus
            rows={2}
            value={instruction}
            disabled={busy}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                clearSelection();
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                apply();
              }
            }}
            placeholder="What should change here? e.g. make this button green and wider"
            className="max-h-32 w-full resize-none bg-transparent px-3 py-2.5 text-[13px] text-zinc-100 placeholder-zinc-600 outline-none disabled:opacity-60"
          />

          {isOldVersion && !feedback && (
            <div className="px-3 pb-1 text-[11px] leading-4 text-amber-300/80">
              You're editing an older version of this artifact — applying starts a new
              version from it.
            </div>
          )}

          {feedback && (
            <div className={clsx('px-3 pb-1 text-[11px] leading-4', feedbackTone)}>{feedback}</div>
          )}

          <div className="flex items-center justify-between gap-2 px-3 pb-2.5 pt-1">
            <span className="text-[10px] text-zinc-600">Only this element is rewritten</span>
            <button
              type="button"
              onClick={apply}
              disabled={busy || !instruction.trim()}
              className="flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 px-3 py-1.5 text-[12px] font-semibold text-white transition-opacity disabled:opacity-40"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
              {busy ? 'Editing…' : 'Apply'}
              {!busy && <CornerDownLeft size={11} className="opacity-60" />}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
