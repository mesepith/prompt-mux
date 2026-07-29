/** Word document helpers (server). Converts .docx via mammoth (pure JS) and
 * .doc via macOS textutil. The resulting HTML is stored on the message and
 * injected as context — works with every model (text-based, like PDF text). */
import mammoth from 'mammoth';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

export const MAX_DOCS = 2;
export const MAX_DOC_DATAURL_LENGTH = 11_000_000;
export const DOC_STORE_CHARS = 100_000;
export const DOC_CURRENT_MAX_CHARS = 60_000;
export const DOC_HISTORY_MAX_CHARS = 15_000;

export const isDocx = (name) => /\.docx$/i.test(name || '');
export const isDoc = (name) => /\.doc$/i.test(name || '');

export function validateDocDataUrl(url, name) {
  if (typeof url !== 'string') return 'Document must be a data URL string';
  if (!/^data:[^;]+;base64,/.test(url)) return 'Invalid data URL';
  if (url.length > MAX_DOC_DATAURL_LENGTH) return 'Document is too large (max ~8 MB)';
  if (!isDocx(name) && !isDoc(name)) return 'Only .doc and .docx files are supported';
  return null;
}

async function extractDocxHtml(dataUrl) {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const buffer = Buffer.from(base64, 'base64');
  const result = await mammoth.convertToHtml({ buffer });
  return result.value;
}

async function extractDocHtmlViaTextutil(dataUrl, name) {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const buffer = Buffer.from(base64, 'base64');
  const dir = await mkdtemp(join(tmpdir(), 'promptmux-doc-'));
  const inputPath = join(dir, name || 'input.doc');
  const outputPath = join(dir, 'output.html');
  try {
    await writeFile(inputPath, buffer);
    await execFileAsync('textutil', ['-convert', 'html', '-output', outputPath, inputPath]);
    return await readFile(outputPath, 'utf-8');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Returns { html } — the HTML representation of the document. */
export async function extractDocHtml(dataUrl, name) {
  let html;
  if (isDocx(name)) {
    html = await extractDocxHtml(dataUrl);
  } else if (isDoc(name)) {
    html = await extractDocHtmlViaTextutil(dataUrl, name);
  } else {
    throw new Error('Unknown document type');
  }
  if (html.length > DOC_STORE_CHARS) {
    html = `${html.slice(0, DOC_STORE_CHARS)}\n[... truncated at ${DOC_STORE_CHARS.toLocaleString()} chars ...]`;
  }
  return { html };
}

/** Build the prompt-injection block for messages carrying doc attachments. */
export function docInjection(attachments, maxChars) {
  const docs = (attachments || []).filter((a) => a.kind === 'doc');
  if (!docs.length) return '';
  return docs
    .map((a) => {
      const full = a.textContent || '';
      const body = full.slice(0, maxChars);
      const note = full.length > maxChars ? '\n[... truncated for context size ...]' : '';
      const content = body.trim() || '[empty document]';
      return `[Content of document "${a.name || 'document'}" (Word doc, converted to HTML)]:\n${content}${note}`;
    })
    .join('\n\n');
}
