import { useEffect, useRef } from 'react';
import { useStore } from '../store/useStore.js';
import MessageBubble from './MessageBubble.jsx';

export default function MessageList() {
  const { messages, streaming, streamingContent, selectedModelId } = useStore();
  const bottomRef = useRef(null);
  const containerRef = useRef(null);
  const stickToBottom = useRef(true);

  // Track whether the user is near the bottom; only auto-scroll if so.
  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  useEffect(() => {
    if (stickToBottom.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
    }
  }, [messages, streamingContent]);

  const streamingMessage = {
    role: 'assistant',
    content: streamingContent,
    modelId: selectedModelId,
  };

  return (
    <div
      ref={containerRef}
      onScroll={onScroll}
      className="flex-1 overflow-y-auto px-4 py-6"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-7">
        {messages.map((m) => (
          <MessageBubble key={m._id} message={m} />
        ))}
        {streaming && <MessageBubble message={streamingMessage} isStreaming />}
        <div ref={bottomRef} className="h-px" />
      </div>
    </div>
  );
}
