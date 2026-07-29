import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy } from 'lucide-react';

function CodeBlock({ className, children }) {
  const [copied, setCopied] = useState(false);
  const text = String(children).replace(/\n$/, '');
  const lang = /language-(\w+)/.exec(className || '')?.[1];

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

  return (
    <div className="codeblock">
      <div className="codeblock-header">
        <span className="codeblock-lang">{lang || 'code'}</span>
        <button className="codeblock-copy" onClick={copy} type="button">
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

export default function Markdown({ content }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          code: CodeBlock,
          // Let CodeBlock own the <pre> wrapper.
          pre: ({ children }) => <>{children}</>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
