import { useEffect, useMemo } from 'react';
import { Download, FileText, X } from 'lucide-react';
import { useStore } from '../store/useStore.js';

/** Convert a data URL to a blob URL — Safari/Chrome won't render data: URLs
 *  for PDFs in iframes, but blob URLs work reliably. */
function dataUrlToBlobUrl(dataUrl) {
  const [meta, base64] = dataUrl.split(',');
  const mime = /data:(.*?);base64/.exec(meta)?.[1] || 'application/octet-stream';
  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return URL.createObjectURL(new Blob([arr], { type: mime }));
}

const DOC_HTML_SHELL = (body) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  body{font-family:system-ui,-apple-system,sans-serif;max-width:800px;margin:0 auto;padding:24px;color:#1a1a1a;line-height:1.6;font-size:15px;}
  img{max-width:100%;height:auto;} table{border-collapse:collapse;} td,th{border:1px solid #ddd;padding:4px 8px;}
  h1,h2,h3{color:#111;}
</style></head><body>${body || '<p style="color:#999">Preview available after sending.</p>'}</body></html>`;

/**
 * Full-screen lightbox for viewing attachments in-place (like ChatGPT/Claude).
 * Images render large; PDFs render via blob URL in iframe; docs render as HTML.
 */
export default function AttachmentViewer() {
  const { activeAttachment, closeAttachment } = useStore();

  // For PDFs: create a blob URL (fixes white-screen in Safari/Chrome)
  const blobUrl = useMemo(() => {
    if (!activeAttachment || activeAttachment.kind !== 'pdf') return null;
    try {
      return dataUrlToBlobUrl(activeAttachment.dataUrl);
    } catch {
      return null;
    }
  }, [activeAttachment]);

  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  useEffect(() => {
    if (!activeAttachment) return;
    const onKey = (e) => {
      if (e.key === 'Escape') closeAttachment();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [activeAttachment, closeAttachment]);

  if (!activeAttachment) return null;
  const { kind, dataUrl, name, textContent } = activeAttachment;

  const download = () => {
    if (!dataUrl) return;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = name || (kind === 'pdf' ? 'document.pdf' : kind === 'doc' ? 'document.docx' : 'image');
    a.click();
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-black/90 backdrop-blur-sm animate-fade-in"
      onClick={closeAttachment}
    >
      <div className="flex items-center gap-3 px-4 py-3" onClick={(e) => e.stopPropagation()}>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-200">
          {name || (kind === 'pdf' ? 'document.pdf' : kind === 'doc' ? 'document' : 'image')}
        </span>
        {dataUrl && (
          <button
            type="button"
            onClick={download}
            title="Download"
            className="rounded-lg p-2 text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100"
          >
            <Download size={17} />
          </button>
        )}
        <button
          type="button"
          onClick={closeAttachment}
          title="Close (Esc)"
          className="rounded-lg p-2 text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100"
        >
          <X size={19} />
        </button>
      </div>
      <div
        className="flex min-h-0 flex-1 items-center justify-center p-4 pb-8"
        onClick={(e) => e.stopPropagation()}
      >
        {kind === 'doc' ? (
          <iframe
            srcDoc={DOC_HTML_SHELL(textContent)}
            title={name || 'Document preview'}
            className="h-full w-full max-w-5xl rounded-xl bg-white shadow-2xl"
          />
        ) : kind === 'pdf' ? (
          blobUrl ? (
            <object
              data={blobUrl}
              type="application/pdf"
              className="h-full w-full max-w-5xl rounded-xl bg-white shadow-2xl"
            >
              <embed src={blobUrl} type="application/pdf" className="h-full w-full" />
              <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
                <p className="text-sm text-zinc-400">
                  Your browser can't display this PDF inline.
                </p>
                <button
                  type="button"
                  onClick={download}
                  className="rounded-lg bg-white/10 px-4 py-2 text-sm text-zinc-200 hover:bg-white/20"
                >
                  Download PDF
                </button>
              </div>
            </object>
          ) : (
            <div className="flex h-full max-w-md flex-col items-center justify-center gap-3 rounded-xl bg-surface-800 p-8 text-center">
              <FileText size={32} className="text-rose-400" />
              <p className="text-sm text-zinc-300">{name || 'document.pdf'}</p>
              <p className="text-xs text-zinc-500">
                This PDF is too large to preview inline (over ~8 MB).
              </p>
            </div>
          )
        ) : (
          <img
            src={dataUrl}
            alt={name || 'attached image'}
            className="max-h-full max-w-full rounded-xl object-contain shadow-2xl"
          />
        )}
      </div>
    </div>
  );
}
