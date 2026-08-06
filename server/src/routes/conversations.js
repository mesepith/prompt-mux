import { Router } from 'express';
import mongoose from 'mongoose';
import { Conversation } from '../models/Conversation.js';
import { Message } from '../models/Message.js';
import { Artifact } from '../models/Artifact.js';
import {
  getModel,
  getCompany,
  isCompanyAvailable,
  modelUnavailableReason,
} from '../config/registry.js';
import { SYSTEM_PROMPT } from '../config/systemPrompt.js';
import { EDIT_SYSTEM_PROMPT, buildEditPrompt, cleanFragment, rootTag } from '../config/editPrompt.js';
import { streamChat, describeImages } from '../providers/index.js';
import { editFragment as demoEditFragment } from '../providers/demo.js';
import {
  extractArtifacts,
  artifactFence,
  summarizeArtifactFences,
  deriveTitle,
  MIN_ARTIFACT_CHARS,
} from '../lib/artifacts.js';
import {
  parsePatch,
  applyPatch,
  patchStats,
  hunksForStorage,
  describeFailures,
  patchMarkerIndex,
  SNIFF_HOLDBACK,
} from '../lib/patch.js';
import { buildArtifactMap, renderArtifactMap } from '../lib/artifactMap.js';
import { PATCH_RULES, buildArtifactContext, buildRepairPrompt } from '../config/patchPrompt.js';
import { validateImageDataUrl, MAX_IMAGES } from '../lib/images.js';
import { renderPdfPagesToImages } from '../lib/pdfImages.js';
import {
  validatePdfDataUrl,
  pdfInjection,
  MAX_PDFS,
  PDF_CURRENT_MAX_CHARS,
  PDF_HISTORY_MAX_CHARS,
} from '../lib/pdf.js';
import {
  validateDocDataUrl,
  extractDocHtml,
  docInjection,
  MAX_DOCS,
  DOC_CURRENT_MAX_CHARS,
  DOC_HISTORY_MAX_CHARS,
} from '../lib/doc.js';
import {
  validateSheetDataUrl,
  extractSheetText,
  sheetInjection,
  MAX_SHEETS,
  SHEET_MAX_CHARS,
} from '../lib/sheet.js';
import { ownerFilter, ownsConversation } from '../middleware/auth.js';
import { audit } from '../models/AuditLog.js';
import { clientIp } from '../lib/clientIp.js';

const router = Router();

const ANONYMOUS_MESSAGE_LIMIT = Number(process.env.ANONYMOUS_MESSAGE_LIMIT) || 3;

// A patched artifact still has to be readable back out of its own fence, so it
// must clear the threshold extractArtifacts applies. Below it, the message would
// look like it carried an artifact and carry none.
const PATCH_LIMITS = { minLength: MIN_ARTIFACT_CHARS };

function ownerId(req) {
  if (req.userId) return { userId: req.userId };
  if (req.sessionId) return { sessionId: req.sessionId };
  return null;
}

/**
 * Owner to stamp on a message. Derived from the CONVERSATION, not the request.
 *
 * A message's owner is meant to mirror its conversation's (see AGENTS.md), and the
 * conversation is the authority: it can't exist without one. Taking it from the
 * request instead means a call that arrives with neither a cookie nor an
 * X-Session-Id header writes a message with no owner at all — which is how
 * production ended up with rows that no usage report could attribute to anyone.
 * Falls back to the request only if a conversation somehow has no owner either.
 */
function messageOwner(conversation, req) {
  // The IP comes from the request even though the owner comes from the
  // conversation: it describes who sent THIS message, which is the whole point of
  // recording it per message.
  const ip = clientIp(req);
  const base = ip ? { ip } : {};
  if (conversation?.userId) return { ...base, userId: conversation.userId };
  if (conversation?.sessionId) return { ...base, sessionId: conversation.sessionId };
  return { ...base, ...(ownerId(req) || {}) };
}

/**
 * The artifact a chat message is about: the newest one in the conversation.
 *
 * Index 0 of the newest artifact-bearing message on purpose — that is exactly
 * what the client opens in the panel (see the store's `finish`), so "fix the
 * jump" edits the thing the user is actually looking at. Any role counts, so
 * pasting HTML and then asking for a fix works too.
 */
function findLiveArtifact(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const found = extractArtifacts(messages[i].content)[0];
    if (!found) continue;
    return {
      ...found,
      messageId: messages[i]._id,
      title: deriveTitle(found.language, found.code),
    };
  }
  return null;
}

// GET /api/conversations — sidebar list, newest first.
router.get('/', async (req, res, next) => {
  try {
    const filter = ownerFilter(req);
    const conversations = await Conversation.find(filter).sort({ lastMessageAt: -1 }).lean();
    res.json(conversations);
  } catch (err) {
    next(err);
  }
});

// POST /api/conversations — { modelId, visionModelId? } -> new empty conversation.
router.post('/', async (req, res, next) => {
  try {
    const { modelId, visionModelId } = req.body || {};
    // Deactivated models are rejected up front: the picker never offers them, so
    // reaching here means a stale client or a hand-made request.
    const unavailable = modelUnavailableReason(getModel(modelId));
    if (unavailable) return res.status(400).json({ error: unavailable });
    if (visionModelId) {
      const vm = getModel(visionModelId);
      const vmUnavailable = modelUnavailableReason(vm);
      if (vmUnavailable) return res.status(400).json({ error: vmUnavailable });
      if (!vm.vision)
        return res.status(400).json({ error: `${vm.name} does not support image input` });
    }
    const owner = ownerId(req);
    if (!owner) return res.status(400).json({ error: 'Authentication required' });
    const ip = clientIp(req);
    const conversation = await Conversation.create({
      modelId,
      ...(visionModelId ? { visionModelId } : {}),
      ...(ip ? { ip, lastIp: ip } : {}),
      ...owner,
    });
    res.status(201).json(conversation);
  } catch (err) {
    next(err);
  }
});

// GET /api/conversations/:id — conversation with full message history.
// Shared/bookmarked links can be stale or mistyped, so a bad id is a 404, not a 500.
// A shared conversation is readable by anyone, but only the owner can modify it.
router.get('/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id))
      return res.status(404).json({ error: 'Conversation not found' });
    const conversation = await Conversation.findById(req.params.id).lean();
    const isOwner = conversation ? ownsConversation(req, conversation) : false;
    if (!conversation || (!isOwner && !conversation.shared))
      return res.status(404).json({ error: 'Conversation not found' });
    const messages = await Message.find({ conversationId: conversation._id })
      .sort({ createdAt: 1 })
      .lean();
    // Don't expose the original owner's id to public viewers.
    const safeConversation = isOwner
      ? conversation
      : { ...conversation, userId: undefined, sessionId: undefined };
    res.json({
      ...safeConversation,
      messages,
      // Extra flags for the client to decide whether to show editor controls
      // and whether a "send" should fork first.
      isOwner,
      shared: conversation.shared,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/conversations/:id — rename, switch model, set vision (file-model) model.
router.patch('/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id))
      return res.status(404).json({ error: 'Conversation not found' });
    const conversation = await Conversation.findById(req.params.id);
    if (!conversation || !ownsConversation(req, conversation))
      return res.status(404).json({ error: 'Conversation not found' });

    const { title, modelId, visionModelId, shared } = req.body || {};
    if (modelId) {
      const unavailable = modelUnavailableReason(getModel(modelId));
      if (unavailable) return res.status(400).json({ error: unavailable });
    }
    if (visionModelId) {
      const vm = getModel(visionModelId);
      const vmUnavailable = modelUnavailableReason(vm);
      if (vmUnavailable) return res.status(400).json({ error: vmUnavailable });
      if (!vm.vision)
        return res.status(400).json({ error: `${vm.name} does not support image input` });
    }
    const update = {};
    if (typeof title === 'string' && title.trim()) update.title = title.trim().slice(0, 80);
    if (modelId) update.modelId = modelId;
    if (visionModelId) update.visionModelId = visionModelId;
    if (typeof shared === 'boolean') {
      update.shared = shared;
      update.sharedAt = shared ? new Date() : null;
    }
    const updated = await Conversation.findByIdAndUpdate(req.params.id, update, { new: true });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// POST /api/conversations/:id/fork — create a private copy of a shared chat.
// Anyone can call this on a shared conversation; the copy is owned by the caller.
router.post('/:id/fork', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id))
      return res.status(404).json({ error: 'Conversation not found' });
    const source = await Conversation.findById(req.params.id).lean();
    if (!source || !source.shared)
      return res.status(404).json({ error: 'Conversation not found' });
    const owner = ownerId(req);
    if (!owner) return res.status(400).json({ error: 'Authentication required' });

    const forkIp = clientIp(req);
    const forked = await Conversation.create({
      title: source.title,
      modelId: source.modelId,
      ...(source.visionModelId ? { visionModelId: source.visionModelId } : {}),
      forkedFrom: source._id,
      ...(forkIp ? { ip: forkIp, lastIp: forkIp } : {}),
      ...owner,
    });

    const sourceMessages = await Message.find({ conversationId: source._id })
      .sort({ createdAt: 1 })
      .lean();
    if (sourceMessages.length > 0) {
      await Message.insertMany(
        sourceMessages.map((m) => ({
          conversationId: forked._id,
          role: m.role,
          content: m.content,
          modelId: m.modelId,
          attachments: m.attachments,
          usage: m.usage,
          visionUsage: m.visionUsage,
          error: m.error,
          artifactEdit: m.artifactEdit,
          ...owner,
        }))
      );
    }

    const messages = await Message.find({ conversationId: forked._id })
      .sort({ createdAt: 1 })
      .lean();
    res.status(201).json({ ...forked.toObject(), messages, isOwner: true, shared: false });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/conversations/:id — removes conversation and its messages.
router.delete('/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id))
      return res.status(404).json({ error: 'Conversation not found' });
    const conversation = await Conversation.findOne({ _id: req.params.id, ...ownerFilter(req) });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    await Conversation.findByIdAndDelete(conversation._id);
    await Message.deleteMany({ conversationId: conversation._id });
    // Published /a/<id> links outlive the panel they were made from, so they
    // have to be retired here or a deleted chat keeps serving its artifacts.
    await Artifact.deleteMany({ conversationId: conversation._id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/conversations/:id/artifact-edit — surgical, point-and-click artifact editing.
 *
 * Body: { messageId, artifactIndex, start, end, snippet, instruction, targetLabel?, modelId? }
 *
 * The client picked one element in the sandboxed preview and knows its exact
 * character range in the stored artifact code (see client/src/lib/htmlNodes.js).
 * The model is asked for ONLY that fragment's replacement — never the whole
 * document — and the server splices it in. `snippet` must still match the code
 * at [start, end) or the request is rejected, so a stale selection can never
 * clobber a different part of the document.
 *
 * Result is persisted as a normal user+assistant message pair (so history, the
 * artifact panel and reloads all keep working) with `artifactEdit` metadata.
 */
router.post('/:id/artifact-edit', async (req, res, next) => {
  try {
    const { messageId, artifactIndex, start, end, snippet, instruction, targetLabel, modelId } =
      req.body || {};

    const text = typeof instruction === 'string' ? instruction.trim() : '';
    if (!text) return res.status(400).json({ error: 'instruction is required' });
    if (text.length > 2000) return res.status(400).json({ error: 'instruction is too long' });
    if (typeof snippet !== 'string' || !snippet.length)
      return res.status(400).json({ error: 'snippet is required' });
    if (snippet.length > 120_000)
      return res.status(400).json({ error: 'Selected element is too large to edit — pick a smaller part' });
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start)
      return res.status(400).json({ error: 'Invalid selection range' });
    if (!mongoose.isValidObjectId(req.params.id))
      return res.status(404).json({ error: 'Conversation not found' });
    if (!mongoose.isValidObjectId(messageId))
      return res.status(404).json({ error: 'Message not found in this conversation' });

    const conversation = await Conversation.findById(req.params.id);
    if (!conversation || !ownsConversation(req, conversation))
      return res.status(404).json({ error: 'Conversation not found' });

    // A point-edit is a paid model call like any other, so it counts against the
    // anonymous allowance too — otherwise this endpoint is an unmetered way for a
    // stranger to spend the owner's API credits.
    if (!req.userId && req.sessionId) {
      const sent = await Message.countDocuments({ sessionId: req.sessionId, role: 'user' });
      if (sent >= ANONYMOUS_MESSAGE_LIMIT) {
        audit({
          event: 'anonymous_limit_reached',
          sessionId: req.sessionId,
          req,
          metadata: { messageCount: sent, limit: ANONYMOUS_MESSAGE_LIMIT, route: 'artifact-edit' },
        });
        return res.status(403).json({
          error: 'Anonymous message limit reached. Please sign up or log in to continue.',
          code: 'ANONYMOUS_LIMIT_REACHED',
        });
      }
    }

    const sourceMessage = await Message.findById(messageId);
    if (!sourceMessage || String(sourceMessage.conversationId) !== String(conversation._id))
      return res.status(404).json({ error: 'Message not found in this conversation' });

    const artifacts = extractArtifacts(sourceMessage.content);
    const index = Number.isInteger(artifactIndex) ? artifactIndex : 0;
    const artifact = artifacts[index];
    if (!artifact) return res.status(404).json({ error: 'Artifact not found on that message' });

    // The selection must still describe the stored code exactly.
    if (end > artifact.code.length || artifact.code.slice(start, end) !== snippet)
      return res.status(409).json({
        error: 'This artifact changed since you selected that element — reopen the preview and pick it again.',
      });

    const model = getModel(modelId || conversation.modelId);
    if (!model) return res.status(400).json({ error: 'Unknown modelId' });

    // The label is derived from the artifact's own tag/id/class, i.e. text a model
    // wrote, and it gets interpolated into message content — so keep it to the
    // shape it's meant to have (tag#id.class) rather than letting it smuggle
    // markdown (a link, an image) into the assistant's own transcript.
    const label = (typeof targetLabel === 'string' ? targetLabel : '')
      .replace(/[^\w.#:-]/g, '')
      .slice(0, 60);

    let replacement;
    let usage = null;
    try {
      if (model.company === 'demo') {
        // Offline path: deterministic marker edit, no model involved.
        const result = await demoEditFragment({ snippet, instruction: text });
        replacement = result.content;
      } else {
        const result = await streamChat({
          model,
          messages: [
            {
              role: 'user',
              content: buildEditPrompt({
                code: artifact.code,
                start,
                end,
                snippet,
                instruction: text,
                language: artifact.language,
                targetLabel: label,
              }),
            },
          ],
          system: EDIT_SYSTEM_PROMPT,
          onToken: () => {},
        });
        usage = result.usage || null;
        replacement = cleanFragment(result.content, snippet);
      }
    } catch (err) {
      return res.status(502).json({ error: err?.message || 'The edit failed' });
    }

    const newCode = artifact.code.slice(0, start) + replacement + artifact.code.slice(end);
    const unchanged = replacement.trim() === snippet.trim();
    const tagSwapped = rootTag(replacement) !== rootTag(snippet);

    const meta = {
      instruction: text,
      target: label,
      sourceMessageId: sourceMessage._id,
    };
    const owner = messageOwner(conversation, req);
    const userMessage = await Message.create({
      conversationId: conversation._id,
      role: 'user',
      content: label ? `Edit \`${label}\`: ${text}` : `Edit selected element: ${text}`,
      artifactEdit: meta,
      ...owner,
    });
    const message = await Message.create({
      conversationId: conversation._id,
      role: 'assistant',
      modelId: model.id,
      content: [
        `Updated \`${label || 'the selected element'}\`${unchanged ? ' — no change was needed' : ''}.`,
        '',
        artifactFence(artifact.language, newCode),
      ].join('\n'),
      ...(usage ? { usage } : {}),
      artifactEdit: meta,
      ...owner,
    });

    conversation.lastMessageAt = new Date();
    await conversation.save();

    res.json({
      userMessage,
      message,
      conversation,
      unchanged,
      tagSwapped,
      usage,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/conversations/:id/messages — { content, modelId?, images?: [dataUrl], pdfs?: [{name, dataUrl}] }
 *
 * Unified file-model routing:
 * - Files (images, PDFs) go DIRECTLY to the chat model if the model supports them.
 * - Any file type the chat model CAN'T handle triggers the two-model flow:
 *   1. PDFs are rendered to pages images server-side (format conversion, not content reading)
 *   2. A vision model (conversation.visionModelId — REQUIRED, no auto-pick) describes ALL files
 *   3. The description is injected into the chat model's context
 *   4. visionUsage tracks the file-reading step's tokens
 */
router.post('/:id/messages', async (req, res, next) => {
  try {
    const { content, modelId } = req.body || {};
    const images = Array.isArray(req.body?.images) ? req.body.images : [];
    const pdfs = Array.isArray(req.body?.pdfs) ? req.body.pdfs : [];
    const docs = Array.isArray(req.body?.docs) ? req.body.docs : [];
    const sheets = Array.isArray(req.body?.sheets) ? req.body.sheets : [];
    if ((!content || !content.trim()) && !images.length && !pdfs.length && !docs.length && !sheets.length)
      return res.status(400).json({ error: 'content, images, pdfs, docs or sheets are required' });
    if (images.length > MAX_IMAGES)
      return res.status(400).json({ error: `Max ${MAX_IMAGES} images per message` });
    if (pdfs.length > MAX_PDFS)
      return res.status(400).json({ error: `Max ${MAX_PDFS} PDFs per message` });
    if (docs.length > MAX_DOCS)
      return res.status(400).json({ error: `Max ${MAX_DOCS} documents per message` });
    if (sheets.length > MAX_SHEETS)
      return res.status(400).json({ error: `Max ${MAX_SHEETS} spreadsheets per message` });
    for (const url of images) {
      const invalid = validateImageDataUrl(url);
      if (invalid) return res.status(400).json({ error: invalid });
    }
    for (const p of pdfs) {
      const invalid = validatePdfDataUrl(p?.dataUrl);
      if (invalid) return res.status(400).json({ error: invalid });
    }

    // Convert .doc/.docx to HTML server-side (accurate format decoding, not OCR).
    const docAttachments = [];
    for (const d of docs) {
      const invalid = validateDocDataUrl(d?.dataUrl, d?.name);
      if (invalid) return res.status(400).json({ error: invalid });
      try {
        const { html } = await extractDocHtml(d.dataUrl, d.name);
        docAttachments.push({
          kind: 'doc',
          name: (d.name || 'document.docx').slice(0, 200),
          mimeType: 'text/html',
          textContent: html,
        });
      } catch (err) {
        return res.status(400).json({ error: `Could not read "${d.name}" — ${err.message}` });
      }
    }

    // Spreadsheets become text at upload time and the binary is never stored —
    // same contract as docs, so every model can read them (see lib/sheet.js).
    const sheetAttachments = [];
    for (const sheetFile of sheets) {
      const invalid = validateSheetDataUrl(sheetFile?.dataUrl, sheetFile?.name);
      if (invalid) return res.status(400).json({ error: invalid });
      try {
        const { text, sheetCount } = await extractSheetText(sheetFile.dataUrl, sheetFile.name);
        sheetAttachments.push({
          kind: 'sheet',
          name: (sheetFile.name || 'spreadsheet.xlsx').slice(0, 200),
          mimeType: 'text/markdown',
          sheetCount,
          textContent: text,
        });
      } catch (err) {
        return res.status(400).json({ error: `Could not read "${sheetFile.name}" — ${err.message}` });
      }
    }

    const conversation = await Conversation.findById(req.params.id);
    if (!conversation || !ownsConversation(req, conversation))
      return res.status(404).json({ error: 'Conversation not found' });

    // Anonymous users can only send a limited total number of messages.
    if (!req.userId && req.sessionId) {
      const sent = await Message.countDocuments({ sessionId: req.sessionId, role: 'user' });
      if (sent >= ANONYMOUS_MESSAGE_LIMIT) {
        audit({ event: 'anonymous_limit_reached', sessionId: req.sessionId, req, metadata: { messageCount: sent, limit: ANONYMOUS_MESSAGE_LIMIT } });
        return res.status(403).json({
          error: 'Anonymous message limit reached. Please sign up or log in to continue.',
          code: 'ANONYMOUS_LIMIT_REACHED',
        });
      }
    }

    const model = getModel(modelId || conversation.modelId);
    if (!model) return res.status(400).json({ error: 'Unknown modelId' });

    const text = (content || '').trim();
    const owner = messageOwner(conversation, req);

    // Save the user message (images stored as data URLs; PDFs stored as metadata
    // only — their actual reading happens via the vision-model flow below).
    const imageAttachments = images.map((dataUrl) => ({
      kind: 'image',
      dataUrl,
      mimeType: /^data:([^;]+)/.exec(dataUrl)?.[1] || 'image/png',
    }));
    const pdfAttachments = pdfs.map((p) => ({
      kind: 'pdf',
      name: (p.name || 'document.pdf').slice(0, 200),
      mimeType: 'application/pdf',
      // Store the data URL so the lightbox can render the PDF.
      // Skip if too large (MongoDB 16MB doc limit) — lightbox shows a notice.
      ...(p.dataUrl && p.dataUrl.length < 12_000_000 ? { dataUrl: p.dataUrl } : {}),
    }));
    const attachments = [...imageAttachments, ...pdfAttachments, ...docAttachments, ...sheetAttachments];
    const userMessage = await Message.create({
      conversationId: conversation._id,
      role: 'user',
      content: text,
      ...(attachments.length ? { attachments } : {}),
      ...owner,
    });
    const messageCount = await Message.countDocuments({ conversationId: conversation._id });
    conversation.modelId = model.id;
    if (messageCount === 1)
      conversation.title = (text || pdfAttachments[0]?.name || docAttachments[0]?.name || sheetAttachments[0]?.name || 'Image chat').slice(0, 60);
    conversation.lastMessageAt = new Date();
    const senderIp = clientIp(req);
    if (senderIp) conversation.lastIp = senderIp;
    await conversation.save();

    // --- SSE stream ---
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    send({ type: 'start', userMessage, conversation });

    const controller = new AbortController();
    let clientGone = false;
    req.on('close', () => {
      clientGone = true;
      controller.abort();
    });

    // Helper: persist an assistant message (error or normal) and finish.
    const finishWith = async ({ content: c = '', usage, visionUsage, error, artifactEdit }) => {
      const message = await Message.create({
        conversationId: conversation._id,
        role: 'assistant',
        content: c,
        modelId: model.id,
        ...(usage ? { usage } : {}),
        ...(visionUsage ? { visionUsage } : {}),
        ...(error ? { error } : {}),
        ...(artifactEdit ? { artifactEdit } : {}),
        ...owner,
      });
      send(error ? { type: 'error', error, message } : { type: 'done', message });
      res.end();
    };

    /**
     * One turn can cost more than one model call (a patch, its repair, a
     * fallback rewrite). Cost tracking is per message, so those add up — showing
     * only the last call's usage would under-report what the turn actually spent.
     */
    const sumUsage = (calls) => {
      const items = calls.filter(Boolean);
      if (!items.length) return null;
      const add = (key) => items.reduce((n, u) => n + (u[key] || 0), 0);
      const reasoning = add('reasoningTokens');
      const cached = add('cachedInputTokens');
      const input = add('inputTokens');
      const output = add('outputTokens');
      return {
        inputTokens: input,
        outputTokens: output,
        // Summed like the rest: a repair call re-reads the same prefix, so its hit
        // belongs to the same turn's bill.
        ...(cached ? { cachedInputTokens: cached } : {}),
        // max, not `||`: when one call reports totalTokens and another doesn't,
        // summing the reported ones alone is a truthy UNDERCOUNT, and the cost
        // shown to the user would be less than the turn actually spent.
        totalTokens: Math.max(add('totalTokens'), input + output),
        ...(reasoning ? { reasoningTokens: reasoning } : {}),
      };
    };

    try {
      let visionUsage = null;
      let fileDescription = null;
      const needsFileModel =
        (images.length > 0 && !model.vision) || (pdfs.length > 0 && !model.pdf);

      // --- Two-model file flow (images and/or PDFs the chat model can't handle) ---
      if (needsFileModel) {
        const visionModel = getModel(conversation.visionModelId);
        if (!visionModel || !visionModel.vision || !isCompanyAvailable(getCompany(visionModel.company))) {
          const missing = pdfs.length && !model.pdf ? 'PDF' : 'image';
          const action = images.length && !model.vision
            ? (pdfs.length ? 'read these files' : 'see images')
            : `handle ${missing}s`;
          await finishWith({
            error: `${model.name} can't ${action}. Pick a vision-capable model in the composer's file dropdown and try again.`,
          });
          return;
        }

        // Render PDF pages to images (format conversion — the vision model reads the images)
        let allImages = [...images];
        for (let i = 0; i < pdfs.length; i++) {
          send({ type: 'status', content: `Rendering "${pdfs[i].name}" pages to images…` });
          const rendered = await renderPdfPagesToImages(pdfs[i].dataUrl);
          allImages.push(...rendered.images);
          pdfAttachments[i].pageCount = rendered.totalPages;
        }

        send({ type: 'status', content: `Reading ${allImages.length} page(s) with ${visionModel.name}…` });
        const describeResult = await describeImages({
          visionModel,
          images: allImages,
          question: text,
          signal: controller.signal,
        });
        if (describeResult.usage) {
          visionUsage = { modelId: visionModel.id, ...describeResult.usage };
        }
        fileDescription = describeResult.description;

        // Store the description on each PDF attachment so follow-up messages
        // (history injection via pdfInjection) can reuse it without re-rendering.
        for (const att of pdfAttachments) {
          att.textContent = fileDescription;
          att.scanned = true;
        }
        await Message.findByIdAndUpdate(userMessage._id, { attachments });

        send({ type: 'status', content: `${model.name} is replying…` });
      }

      // --- Provider history (capped, with injected PDF descriptions) ---
      const history = await Message.find({ conversationId: conversation._id })
        .sort({ createdAt: 1 })
        .limit(80)
        .lean();
      const usable = history.filter(
        (m) => (m.content && m.content.trim()) || m.attachments?.length
      );

      // The live artifact — the version the user is looking at, and the one a
      // "fix the collision" message means. When there is one, its source is
      // injected ONCE below and every copy in the history is summarized away, so
      // the model sees exactly one version instead of one per edit round.
      const liveArtifact = findLiveArtifact(usable);
      const patchMode = Boolean(liveArtifact);

      // No artifact to edit: keep the original rule (trim superseded point-edit
      // copies, keep the last two turns verbatim) so nothing regresses.
      const keepFullFrom = usable.length - 2;
      const providerMessages = usable.map((m, idx) => {
        const isLast = idx === usable.length - 1;
        const baseContent = patchMode
          ? summarizeArtifactFences(m.content, 'current source is included with the latest message')
          : m.artifactEdit?.instruction && idx < keepFullFrom
            ? summarizeArtifactFences(m.content)
            : m.content;
        // `kind === 'image'`, NOT `!== 'pdf'`. Only images carry a dataUrl —
        // docs and sheets are stored as extracted text — so an allow-all-but-pdf
        // filter sent `images: [null]` to the provider for every Word doc on a
        // vision-capable model.
        const imageAtts = (m.attachments || []).filter((a) => a.kind === 'image');
        const pdfText = pdfInjection(
          m.attachments,
          isLast ? PDF_CURRENT_MAX_CHARS : PDF_HISTORY_MAX_CHARS
        );
        const docText = docInjection(
          m.attachments,
          isLast ? DOC_CURRENT_MAX_CHARS : DOC_HISTORY_MAX_CHARS
        );
        // One stable cap, no isLast — a block that shrinks once it stops being
        // the newest message would move the prompt bytes and drop the cache.
        const sheetText = sheetInjection(m.attachments, SHEET_MAX_CHARS);
        const injectedText = [pdfText, docText, sheetText].filter(Boolean).join('\n\n');
        const resolvedContent = injectedText
          ? `${baseContent}\n\n${injectedText}`.trim()
          : baseContent;
        return {
          role: m.role,
          content: resolvedContent,
          ...(imageAtts.length
            ? model.vision
              ? { images: imageAtts.map((a) => a.dataUrl) }
              : { content: `${resolvedContent}\n[${imageAtts.length} image(s) attached]`.trim() }
            : {}),
        };
      });

      // Inject the image description into the last provider message (image-only
      // attachments don't carry stored descriptions like PDFs do).
      if (images.length && !model.vision && fileDescription) {
        const lastUser = providerMessages[providerMessages.length - 1];
        const vmName = getModel(conversation.visionModelId)?.name || 'file model';
        lastUser.content = `${lastUser.content}\n\n[File understanding by ${vmName}]:\n${fileDescription}`.trim();
      }

      // The live source rides on the user's own message, like PDF and doc text
      // does — it is per-turn content, and that is where the model looks for what
      // it was just asked about.
      //
      // It goes at the FRONT, before the user's words, for two reasons. Prompt
      // caching only ever reuses a PREFIX, so anything placed after the question
      // can never be cached — and the question is the one part that changes every
      // turn. Putting the stable source first means a turn that doesn't edit the
      // artifact (a question, or the repair call) re-reads it at the cache rate.
      // Recency also favours it: the instruction ends up last, where models follow
      // it best.
      // Kept so the rewrite fallback can rebuild the same message. It is the
      // user's words PLUS any PDF/doc text and vision description composed above —
      // the fallback used to substitute the raw `text` here and silently drop all
      // of that from the request.
      let composedUserContent = null;
      if (patchMode) {
        const lastUser = providerMessages[providerMessages.length - 1];
        composedUserContent = lastUser.content;
        lastUser.content = `${buildArtifactContext({
          code: liveArtifact.code,
          language: liveArtifact.language,
          title: liveArtifact.title,
          outline: renderArtifactMap(buildArtifactMap(liveArtifact.code)),
        })}\n\n${composedUserContent}`.trim();
      }

      // End of the reusable prefix: everything up to and including the previous
      // turn. Anthropic caches nothing without this marker (every OpenAI-compatible
      // vendor does it automatically); other adapters ignore the flag. Placed
      // before the newest message because that is the part that is byte-identical
      // next turn — which is where the 53% of re-sent input tokens goes.
      if (providerMessages.length >= 3) {
        providerMessages[providerMessages.length - 2].cacheBoundary = true;
      }

      // Always the same string, whether or not this chat has an artifact — see the
      // note in config/patchPrompt.js. A system prompt that grows mid-chat moves the
      // first bytes of the prompt and throws away the whole prompt cache.
      const system = `${SYSTEM_PROMPT}\n${PATCH_RULES}`;
      const calls = [];

      // Tokens go out live until the reply turns into edit blocks; from there the
      // turn shows a status instead, and `done` replaces it with the finished
      // message. Without patchMode this is a plain pass-through, unchanged.
      let raw = '';
      let emitted = 0;
      let sniffed = false;
      const onToken = patchMode
        ? (delta) => {
            raw += delta;
            if (clientGone || sniffed) return;
            const marker = patchMarkerIndex(raw);
            if (marker !== -1) {
              sniffed = true;
              if (marker > emitted) send({ type: 'token', content: raw.slice(emitted, marker) });
              emitted = raw.length;
              send({ type: 'status', content: 'Making a targeted edit…' });
              return;
            }
            const safe = raw.length - SNIFF_HOLDBACK;
            if (safe > emitted) {
              send({ type: 'token', content: raw.slice(emitted, safe) });
              emitted = safe;
            }
          }
        : (delta) => {
            if (!clientGone) send({ type: 'token', content: delta });
          };
      // The sniffer holds a few characters back; an ordinary answer needs them.
      const flushHeldTokens = () => {
        if (!clientGone && !sniffed && raw.length > emitted) {
          send({ type: 'token', content: raw.slice(emitted) });
          emitted = raw.length;
        }
      };

      const chatResult = await streamChat({
        model,
        messages: providerMessages,
        system,
        signal: controller.signal,
        onToken,
      });
      calls.push(chatResult.usage);

      const parsed = patchMode ? parsePatch(chatResult.content) : { blocks: [], prose: '', problems: [] };
      // A reply carrying a whole ```html document is a rewrite, whatever else is
      // in it — take it at face value rather than mixing the two.
      const rewroteInstead = parsed.blocks.length > 0 && extractArtifacts(chatResult.content).length > 0;

      if (!parsed.blocks.length || rewroteInstead) {
        // An answer, a question, or a full rewrite: exactly today's behaviour.
        flushHeldTokens();
        await finishWith({ content: chatResult.content, usage: sumUsage(calls), visionUsage });
        return;
      }

      let applied = applyPatch(liveArtifact.code, parsed.blocks, PATCH_LIMITS);
      let prose = parsed.prose;
      let fallback = null;

      // One repair attempt. A few hundred tokens against the thousands a full
      // rewrite costs, so it is worth asking twice before giving up on the cheap
      // path — and the model gets to see its own failed blocks.
      if (!applied.ok) {
        if (!clientGone) send({ type: 'status', content: "That edit didn't line up — trying once more…" });
        // The repair re-sends providerMessages verbatim, so within this one turn
        // the source is byte-identical — the single case where the whole artifact
        // is genuinely cacheable. Moving the boundary onto the last of those
        // messages is what lets Anthropic read it back at a tenth of the price
        // instead of paying full price twice in the same turn (every
        // OpenAI-compatible vendor already gets this automatically).
        const repairPrefix = providerMessages.map((m, i) => ({
          ...m,
          cacheBoundary: i === providerMessages.length - 1,
        }));
        const repair = await streamChat({
          model,
          messages: [
            ...repairPrefix,
            { role: 'assistant', content: chatResult.content },
            { role: 'user', content: buildRepairPrompt(describeFailures(applied.failures, parsed.problems)) },
          ],
          system,
          signal: controller.signal,
          onToken: () => {},
        });
        calls.push(repair.usage);
        const retry = parsePatch(repair.content);
        if (retry.blocks.length) {
          const second = applyPatch(liveArtifact.code, retry.blocks, PATCH_LIMITS);
          if (second.ok) {
            applied = second;
            prose = retry.prose || prose;
            fallback = 'repair';
          }
        }
      }

      // Still nothing that applies: regenerate the document — which is what used
      // to happen on every single fix. The user is told, because a turn that
      // quietly spent thousands of output tokens should not be invisible.
      if (!applied.ok) {
        if (!clientGone) {
          send({ type: 'reset' });
          send({ type: 'status', content: 'Targeted edit failed — rewriting the whole artifact…' });
        }
        // Re-frame the source: this call must ask for the whole document, so the
        // "change it with edit blocks, do not reproduce it" instruction has to go.
        //
        // Built in the SAME order as the first call, and from the same composed
        // content, for two reasons. The instruction is the only thing that differs
        // and it sits after the source, so this call still shares the whole
        // ~5k-token source as a cached prefix instead of re-billing it at full
        // price on the most expensive path in the app. And using
        // `composedUserContent` rather than the raw `text` keeps the PDF/doc text
        // and the vision model's file description in the request — substituting
        // `text` dropped them, so a fallback on a chat with attachments asked the
        // model to rewrite a document while withholding what it was about.
        const rewriteMessages = providerMessages.slice(0, -1).concat({
          ...providerMessages[providerMessages.length - 1],
          content: `${buildArtifactContext({
            code: liveArtifact.code,
            language: liveArtifact.language,
            title: liveArtifact.title,
            outline: renderArtifactMap(buildArtifactMap(liveArtifact.code)),
            rewrite: true,
          })}\n\n${composedUserContent}`.trim(),
        });
        const rewrite = await streamChat({
          model,
          messages: rewriteMessages,
          // Same system prompt as every other call, so the cached prefix still
          // matches. The "output the complete document" instruction that overrides
          // the patch rules travels with the message instead (rewrite: true above).
          system,
          signal: controller.signal,
          onToken: (delta) => {
            if (!clientGone) send({ type: 'token', content: delta });
          },
        });
        calls.push(rewrite.usage);

        // Safety net: a model that answers with edit blocks anyway shouldn't cost
        // the user their artifact. If those blocks apply, take them — the turn
        // ends up as the targeted edit it was trying to be all along.
        const lastChance = parsePatch(rewrite.content);
        const salvaged = lastChance.blocks.length
          ? applyPatch(liveArtifact.code, lastChance.blocks, PATCH_LIMITS)
          : { ok: false };
        if (salvaged.ok) {
          applied = salvaged;
          prose = lastChance.prose || prose;
          fallback = 'repair';
        } else {
          await finishWith({
            content: rewrite.content,
            usage: sumUsage(calls),
            visionUsage,
            artifactEdit: { instruction: text.slice(0, 2000), mode: 'patch', fallback: 'rewrite' },
          });
          return;
        }
      }

      // Stored as an ordinary artifact message: a full ```html fence with the
      // patched source. That is what keeps the artifact panel, point-and-edit
      // offsets, published /a/<id> links and the version history in the
      // transcript all working with no special case for patched artifacts.
      const stats = patchStats(applied.applied);
      const summary =
        prose || `Updated the artifact — ${stats.hunks} change${stats.hunks === 1 ? '' : 's'}.`;
      await finishWith({
        content: `${summary}\n\n${artifactFence(liveArtifact.language, applied.code)}`,
        usage: sumUsage(calls),
        visionUsage,
        artifactEdit: {
          instruction: text.slice(0, 2000),
          mode: 'patch',
          sourceMessageId: liveArtifact.messageId,
          hunks: hunksForStorage(applied.applied),
          ...(fallback ? { fallback } : {}),
        },
      });
    } catch (err) {
      const errorMessage = err?.message || 'Generation failed';
      await finishWith({ error: clientGone ? 'Stopped by user' : errorMessage });
    }
  } catch (err) {
    next(err);
  }
});

export default router;
