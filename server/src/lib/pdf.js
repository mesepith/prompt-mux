/** PDF helpers (server). Text extraction is local and free — works with any model.
 * Uses pdfjs-dist directly (single pdf.js library for extraction + page rendering,
 * no cross-package worker conflicts). */
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';

// Node globals pdf.js may touch
if (!globalThis.DOMMatrix) globalThis.DOMMatrix = DOMMatrix;
if (!globalThis.Path2D) globalThis.Path2D = Path2D;
if (!globalThis.ImageData) globalThis.ImageData = ImageData;

const require = createRequire(import.meta.url);
GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
).href;

export const MAX_PDFS = 2;
// ~8 MB binary ≈ ~11 MB base64 per PDF
export const MAX_PDF_DATAURL_LENGTH = 11_000_000;
// Caps for the text we keep/inject (token-cost control)
export const PDF_STORE_CHARS = 100_000;
export const PDF_CURRENT_MAX_CHARS = 60_000; // the message that carries the PDF
export const PDF_HISTORY_MAX_CHARS = 15_000; // older messages in provider history

/** Validate a client-supplied PDF data URL. Returns an error string or null. */
export function validatePdfDataUrl(url) {
  if (typeof url !== 'string') return 'PDF must be a data URL string';
  if (!/^data:application\/pdf;base64,/.test(url)) return 'Only PDF data URLs are supported';
  if (url.length > MAX_PDF_DATAURL_LENGTH) return 'PDF is too large (max ~8 MB each)';
  return null;
}

export function pdfBytesFromDataUrl(dataUrl) {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

export async function openPdf(bytes) {
  const loadingTask = getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true });
  const doc = await loadingTask.promise;
  // pdfjs v6: destroy() lives on the loading task, not the document — normalize it.
  doc.destroy = () => loadingTask.destroy();
  return doc;
}

/** Rebuild readable text from a page's text-content items (rough line breaks). */
function pageText(items) {
  let out = '';
  let lastY = null;
  for (const item of items) {
    const y = item.transform?.[5];
    if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2) out += '\n';
    else if (out && !out.endsWith('\n') && !out.endsWith(' ') && !item.str.startsWith(' ')) {
      // word gap heuristic
    }
    out += item.str;
    if (item.hasEOL) out += '\n';
    lastY = y;
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Extract text from a PDF data URL.
 * Returns { text, pageCount } — text is capped at PDF_STORE_CHARS.
 * Scanned/blank PDFs yield empty text. Throws on corrupt/encrypted files.
 */
export async function extractPdfText(dataUrl) {
  const doc = await openPdf(pdfBytesFromDataUrl(dataUrl));
  const pageCount = doc.numPages;
  const pages = [];
  for (let i = 1; i <= pageCount; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(pageText(content.items));
    page.cleanup();
  }
  await doc.destroy();
  const hasText = pages.some((p) => p.length > 0);
  // Scanned/blank PDFs yield no text layer — return empty so the injection
  // note kicks in instead of bare "--- Page N ---" markers.
  let text = hasText ? pages.map((p, i) => `--- Page ${i + 1} ---\n${p}`).join('\n\n') : '';
  if (text.length > PDF_STORE_CHARS) {
    text = `${text.slice(0, PDF_STORE_CHARS)}\n[... truncated at ${PDF_STORE_CHARS.toLocaleString()} chars ...]`;
  }
  return { text, pageCount };
}

/** Build the prompt-injection block for messages carrying PDF attachments. */
export function pdfInjection(attachments, maxChars) {
  const pdfs = (attachments || []).filter((a) => a.kind === 'pdf');
  if (!pdfs.length) return '';
  return pdfs
    .map((a) => {
      const full = a.textContent || '';
      const body = full.slice(0, maxChars);
      const note = full.length > maxChars ? '\n[... truncated for context size ...]' : '';
      const content = body.trim() || '[no extractable text — this looks like a scanned/image PDF]';
      const header = a.scanned
        ? `[Scanned PDF "${a.name || 'document.pdf'}" (${a.pageCount || '?'} pages) — contents read from page images by a vision model]:`
        : `[Content of PDF "${a.name || 'document.pdf'}" (${a.pageCount || '?'} pages)]:`;
      return `${header}\n${content}${note}`;
    })
    .join('\n\n');
}
