/** Render PDF pages to PNG data URLs — used for scanned/image-only PDFs so a
 * vision model can read them. Shares the single pdfjs-dist instance with
 * lib/pdf.js (no cross-package worker conflicts). */
import { createCanvas } from '@napi-rs/canvas';
import { openPdf, pdfBytesFromDataUrl } from './pdf.js';

const canvasFactory = {
  create(w, h) {
    const canvas = createCanvas(w, h);
    return { canvas, context: canvas.getContext('2d') };
  },
  reset(pair, w, h) {
    pair.canvas.width = w;
    pair.canvas.height = h;
  },
  destroy(pair) {
    pair.canvas.width = 0;
    pair.canvas.height = 0;
  },
};

export const SCANNED_PDF_MAX_PAGES = 2; // per PDF, controls vision-token cost
export const SCANNED_PDF_SCALE = 1.5;

/**
 * dataUrl -> { images: [pngDataUrl], totalPages, renderedPages }
 */
export async function renderPdfPagesToImages(
  dataUrl,
  { maxPages = SCANNED_PDF_MAX_PAGES, scale = SCANNED_PDF_SCALE } = {}
) {
  const doc = await openPdf(pdfBytesFromDataUrl(dataUrl));
  const renderedPages = Math.min(doc.numPages, maxPages);
  const images = [];
  for (let i = 1; i <= renderedPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvasContext: canvas.getContext('2d'), viewport, canvasFactory }).promise;
    images.push(canvas.toDataURL('image/png'));
    page.cleanup();
  }
  await doc.destroy();
  return { images, totalPages: doc.numPages, renderedPages };
}
