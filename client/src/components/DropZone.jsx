import { useRef, useState } from 'react';
import { CloudUpload, FileText, Image as ImageIcon } from 'lucide-react';
import { useStore } from '../store/useStore.js';

/**
 * Drag-and-drop file upload over the whole chat column.
 * Shows an overlay while files are dragged over; drops go into the shared
 * attachments store (same pipeline as the paperclip button).
 */
export default function DropZone({ children }) {
  const { addAttachments, streaming } = useStore();
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

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
