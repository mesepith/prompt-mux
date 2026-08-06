import { useEffect, useRef, useState } from 'react';
import { CloudUpload, FileText, Image as ImageIcon } from 'lucide-react';
import { useStore } from '../store/useStore.js';

/**
 * Drag-and-drop AND paste file upload over the whole chat column.
 * Shows an overlay while files are dragged over; drops and pastes go into the
 * shared attachments store (same pipeline as the paperclip button).
 */
export default function DropZone({ children }) {
  const { addAttachments, streaming } = useStore();
  const [dragging, setDragging] = useState(false);
  const [pasted, setPasted] = useState(0); // bumped to flash a confirmation
  const depth = useRef(0);

  /**
   * Paste-to-attach: ⌘V a screenshot, or a file copied from Finder/Explorer.
   *
   * Listens on the document rather than the textarea because the usual flow is
   * "take a screenshot, hit paste" with focus nowhere in particular. Two rules
   * keep it out of the way: only act when the clipboard actually carries FILES
   * (pasting text, or a copied cell range from Excel, must paste normally), and
   * never call preventDefault otherwise. `clipboardData.files` is empty for a
   * pure text paste, so that check is the whole guard.
   */
  useEffect(() => {
    const onPaste = (e) => {
      if (streaming) return;
      const files = [...(e.clipboardData?.files || [])];
      if (!files.length) return;
      e.preventDefault();
      // A pasted screenshot has no filename in most browsers; give it one so the
      // chip and the stored attachment aren't blank.
      addAttachments(
        files.map((f) =>
          f.name
            ? f
            : new File([f], `pasted-image.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, {
                type: f.type,
              })
        )
      );
      setPasted((n) => n + 1);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [addAttachments, streaming]);

  // Flash the "attached" toast for a moment, then clear it.
  useEffect(() => {
    if (!pasted) return undefined;
    const timer = setTimeout(() => setPasted(0), 1600);
    return () => clearTimeout(timer);
  }, [pasted]);

  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

  const onDragEnter = (e) => {
    if (!hasFiles(e) || streaming) return;
    e.preventDefault();
    depth.current += 1;
    setDragging(true);
  };
  const onDragLeave = (e) => {
    if (!hasFiles(e)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  };
  const onDragOver = (e) => {
    if (hasFiles(e)) e.preventDefault(); // required to allow drop
  };
  const onDrop = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth.current = 0;
    setDragging(false);
    if (!streaming) addAttachments(e.dataTransfer.files);
  };

  return (
    <div
      className="relative flex min-w-0 flex-1 flex-col"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {children}

      {pasted > 0 && !dragging && (
        <div className="pointer-events-none absolute inset-x-0 top-3 z-50 flex justify-center animate-fade-in">
          <span className="flex items-center gap-2 rounded-full border border-emerald-400/30 bg-surface-950/90 px-3 py-1.5 text-[11px] font-medium text-emerald-300 shadow-lg backdrop-blur">
            <CloudUpload size={12} />
            Pasted — attached below
          </span>
        </div>
      )}

      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-none bg-surface-950/80 backdrop-blur-sm animate-fade-in">
          <div className="flex flex-col items-center gap-4 rounded-3xl border-2 border-dashed border-indigo-400/60 bg-indigo-500/[0.06] px-14 py-12">
            <span className="grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-xl shadow-indigo-950/50">
              <CloudUpload size={30} />
            </span>
            <div className="text-lg font-semibold text-zinc-100">Drop files to attach</div>
            <div className="flex items-center gap-4 text-xs text-zinc-400">
              <span className="flex items-center gap-1.5">
                <ImageIcon size={13} className="text-sky-400" /> Images · up to 4 · 5 MB each
              </span>
              <span className="flex items-center gap-1.5">
                <FileText size={13} className="text-rose-400" /> PDFs · up to 2 · 8 MB each
              </span>
              <span className="flex items-center gap-1.5">
                <FileText size={13} className="text-sky-400" /> Docs · up to 2 · 8 MB each
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
