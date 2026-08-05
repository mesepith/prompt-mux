import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy, Maximize2, Minimize2 } from 'lucide-react';
import clsx from 'clsx';
import { codeText, countLines, gutterText } from '../lib/codeText.js';

/**
 * A fenced code block: a header (language, line count, full screen, copy) over a
 * fixed-height scroll box with a line-number gutter.
 *
 * The box is capped instead of growing freely because a 400-line file otherwise
 * pushes the rest of the conversation off the screen — long code scrolls inside
 * its own frame, and the full-screen button is the way out of a 26rem window on
 * a phone. The gutter is ONE sticky column beside the code rather than a number
 * per line, which is what keeps `Copy` and a manual text selection yielding the
 * code alone, and leaves rehype-highlight's markup untouched.
 */
function CodeBlock({ className, children }) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const rootRef = useRef(null);
  const bodyRef = useRef(null);
  // While the model is still writing, follow the newest line — unless the
  // reader has scrolled away from the bottom. Same rule as MessageList applies
  // to the page as a whole.
  const stickToBottom = useRef(false);
  const painted = useRef(false);

  // Read out of the highlighted tree, never String(children) — see lib/codeText.js.
  const text = codeText(children).replace(/\n$/, '');
  const lang = /language-(\w+)/.exec(className || '')?.[1];
  const lineCount = countLines(text);
  // Rebuilt only when a line is added, not on every streamed token.
  const gutter = useMemo(() => gutterText(lineCount), [lineCount]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (!painted.current) {
      painted.current = true;
      // A block that already overflows on its first paint is finished output:
      // show it from line 1 and leave it there. One that still fits is being
      // streamed into, so let it follow along as lines arrive.
      stickToBottom.current = el.scrollHeight - el.clientHeight <= 1;
      return;
    }
    if (stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  // Leaving full screen by any route the browser owns — Esc, F11, the on-screen
  // control — has to drop the overlay too, or the code stays pinned over the
  // chat with no visible way back.
  useEffect(() => {
    if (!expanded) return undefined;
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) setExpanded(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      window.removeEventListener('keydown', onKey);
    };
  }, [expanded]);

  // A streaming reply is replaced by its saved copy when it finishes, which
  // unmounts this block. Hand full screen back rather than leaving the browser
  // in it with nothing to show.
  useEffect(() => {
    const el = rootRef.current;
    return () => {
      if (el && document.fullscreenElement === el) document.exitFullscreen?.();
    };
  }, []);

  // Inline code (`like this`) — no language and no newlines.
  if (!lang && !text.includes('\n')) {
    return <code className={className}>{children}</code>;
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  /**
   * Real fullscreen where the browser allows it on a plain element — that's what
   * takes the browser's own chrome out of the way, which is most of the win on a
   * phone. iOS Safari only fullscreens <video>, so the request is allowed to
   * fail: the CSS class alone already covers the viewport, and that is the part
   * that must never depend on the API.
   */
  const toggleExpanded = () => {
    const el = rootRef.current;
    const next = !expanded;
    setExpanded(next);
    if (next) el?.requestFullscreen?.().catch(() => {});
    else if (document.fullscreenElement) document.exitFullscreen?.();
  };

  return (
    <div ref={rootRef} className={clsx('codeblock', expanded && 'codeblock-expanded')}>
      <div className="codeblock-header">
        <span className="codeblock-lang">
          {lang || 'code'}
          {lineCount > 1 && <span className="codeblock-meta"> · {lineCount} lines</span>}
        </span>
        <div className="codeblock-actions">
          {expanded && <span className="codeblock-meta max-sm:hidden">Esc to exit</span>}
          <button
            className="codeblock-action"
            onClick={toggleExpanded}
            type="button"
            title={expanded ? 'Exit full screen (Esc)' : 'View full screen'}
          >
            {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            {/* Labels go on small screens — three of them plus the line count
                would not fit the width this button exists to make up for. */}
            <span className="max-sm:hidden">{expanded ? 'Exit' : 'Full screen'}</span>
          </button>
          <button className="codeblock-action" onClick={copy} type="button" title="Copy code">
            {copied ? <Check size={13} /> : <Copy size={13} />}
            <span className="max-sm:hidden">{copied ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
      </div>
      <div className="codeblock-body" ref={bodyRef} onScroll={onScroll}>
        <pre>
          {/* aria-hidden + user-select: none — the numbers are chrome, not
              something a screen reader or a copied selection should pick up. */}
          <span className="codeblock-gutter" aria-hidden="true">
            {gutter}
          </span>
          <code className={className}>{children}</code>
        </pre>
      </div>
    </div>
  );
}

/** Let CodeBlock own the <pre> wrapper. */
const PassThrough = ({ children }) => <>{children}</>;

/**
 * Hoisted, not inlined in the JSX below — and that matters more than it looks.
 * A component type declared inside the render is a NEW type on every render, so
 * React unmounts and remounts everything under it: while a reply streams, every
 * token was throwing away and rebuilding every code block in the message,
 * losing its scroll position (and any other DOM state) each time.
 */
const MD_COMPONENTS = { code: CodeBlock, pre: PassThrough };
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];

export default function Markdown({ content }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={MD_COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
