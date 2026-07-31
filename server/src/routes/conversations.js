import { Router } from 'express';
import mongoose from 'mongoose';
import { Conversation } from '../models/Conversation.js';
import { Message } from '../models/Message.js';
import { getModel, getCompany, isCompanyAvailable } from '../config/registry.js';
import { SYSTEM_PROMPT } from '../config/systemPrompt.js';
import { EDIT_SYSTEM_PROMPT, buildEditPrompt, cleanFragment, rootTag } from '../config/editPrompt.js';
import { streamChat, describeImages } from '../providers/index.js';
import { editFragment as demoEditFragment } from '../providers/demo.js';
import { extractArtifacts, artifactFence, summarizeArtifactFences } from '../lib/artifacts.js';
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
import { ownerFilter, ownsConversation } from '../middleware/auth.js';
import { audit } from '../models/AuditLog.js';

const router = Router();

const ANONYMOUS_MESSAGE_LIMIT = Number(process.env.ANONYMOUS_MESSAGE_LIMIT) || 3;

function ownerId(req) {
  if (req.userId) return { userId: req.userId };
  if (req.sessionId) return { sessionId: req.sessionId };
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
    if (!getModel(modelId)) return res.status(400).json({ error: 'Unknown modelId' });
    if (visionModelId) {
      const vm = getModel(visionModelId);
      if (!vm) return res.status(400).json({ error: 'Unknown visionModelId' });
      if (!vm.vision)
        return res.status(400).json({ error: `${vm.name} does not support image input` });
    }
    const owner = ownerId(req);
    if (!owner) return res.status(400).json({ error: 'Authentication required' });
    const conversation = await Conversation.create({
      modelId,
      ...(visionModelId ? { visionModelId } : {}),
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
    if (modelId && !getModel(modelId)) return res.status(400).json({ error: 'Unknown modelId' });
    if (visionModelId) {
      const vm = getModel(visionModelId);
      if (!vm) return res.status(400).json({ error: 'Unknown visionModelId' });
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

    const forked = await Conversation.create({
      title: source.title,
      modelId: source.modelId,
      ...(source.visionModelId ? { visionModelId: source.visionModelId } : {}),
      forkedFrom: source._id,
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
    const owner = ownerId(req) || {};
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
    if ((!content || !content.trim()) && !images.length && !pdfs.length && !docs.length)
      return res.status(400).json({ error: 'content, images, pdfs or docs are required' });
    if (images.length > MAX_IMAGES)
      return res.status(400).json({ error: `Max ${MAX_IMAGES} images per message` });
    if (pdfs.length > MAX_PDFS)
      return res.status(400).json({ error: `Max ${MAX_PDFS} PDFs per message` });
    if (docs.length > MAX_DOCS)
      return res.status(400).json({ error: `Max ${MAX_DOCS} documents per message` });
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
    const owner = ownerId(req) || {};

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
    const attachments = [...imageAttachments, ...pdfAttachments, ...docAttachments];
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
      conversation.title = (text || pdfAttachments[0]?.name || docAttachments[0]?.name || 'Image chat').slice(0, 60);
    conversation.lastMessageAt = new Date();
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
    const finishWith = async ({ content: c = '', usage, visionUsage, error }) => {
      const message = await Message.create({
        conversationId: conversation._id,
        role: 'assistant',
        content: c,
        modelId: model.id,
        ...(usage ? { usage } : {}),
        ...(visionUsage ? { visionUsage } : {}),
        ...(error ? { error } : {}),
        ...owner,
      });
      send(error ? { type: 'error', error, message } : { type: 'done', message });
      res.end();
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
      // Point-and-edit appends a full copy of the artifact per edit. Keep the two
      // most recent turns verbatim and summarize older edit copies, so a long
      // editing session doesn't push the same document at the model ten times.
      const keepFullFrom = usable.length - 2;
      const providerMessages = usable.map((m, idx) => {
        const isLast = idx === usable.length - 1;
        const baseContent =
          m.artifactEdit?.instruction && idx < keepFullFrom
            ? summarizeArtifactFences(m.content)
            : m.content;
        const imageAtts = (m.attachments || []).filter((a) => a.kind !== 'pdf');
        const pdfText = pdfInjection(
          m.attachments,
          isLast ? PDF_CURRENT_MAX_CHARS : PDF_HISTORY_MAX_CHARS
        );
        const docText = docInjection(
          m.attachments,
          isLast ? DOC_CURRENT_MAX_CHARS : DOC_HISTORY_MAX_CHARS
        );
        const injectedText = [pdfText, docText].filter(Boolean).join('\n\n');
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

      const chatResult = await streamChat({
        model,
        messages: providerMessages,
        system: SYSTEM_PROMPT,
        signal: controller.signal,
        onToken: (delta) => {
          if (!clientGone) send({ type: 'token', content: delta });
        },
      });
      await finishWith({ content: chatResult.content, usage: chatResult.usage, visionUsage });
    } catch (err) {
      const errorMessage = err?.message || 'Generation failed';
      await finishWith({ error: clientGone ? 'Stopped by user' : errorMessage });
    }
  } catch (err) {
    next(err);
  }
});

export default router;
