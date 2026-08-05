import { Router } from 'express';
import mongoose from 'mongoose';
import { Artifact } from '../models/Artifact.js';
import { Conversation } from '../models/Conversation.js';
import { Message } from '../models/Message.js';
import { extractArtifacts, deriveTitle } from '../lib/artifacts.js';
import { newPublicId, isPublicId, SESSION_COOKIE, sessionCookieOptions } from '../lib/publicArtifact.js';
import { ownsConversation } from '../middleware/auth.js';
import { clientIp } from '../lib/clientIp.js';

const router = Router();

/**
 * Published artifacts — the `/a/<publicId>` links.
 *
 * Publishing takes a SNAPSHOT of the artifact out of the stored assistant
 * message; the request body only says *which* artifact, never what is in it.
 * This endpoint would otherwise be an open invitation to host arbitrary HTML on
 * this app's origin, which is the one place artifact code must never run.
 *
 * A link is private (`shared: false`) the moment it exists, and only its owner
 * can open it. `PATCH { shared: true }` is what makes it readable by anyone.
 */

/** What the client is allowed to know about a published artifact. */
function publicView(doc) {
  return {
    publicId: doc.publicId,
    path: `/a/${doc.publicId}`,
    shared: doc.shared,
    sharedAt: doc.sharedAt || null,
    title: doc.title,
    language: doc.language,
    conversationId: String(doc.conversationId),
    messageId: String(doc.messageId),
    artifactIndex: doc.artifactIndex,
    views: doc.views || 0,
    createdAt: doc.createdAt,
  };
}

/** True if this request may administer an existing published artifact. */
function ownsArtifact(req, artifact) {
  if (req.userId && String(artifact.userId) === String(req.userId)) return true;
  if (req.sessionId && artifact.sessionId === req.sessionId) return true;
  return false;
}

// POST /api/artifacts — { conversationId, messageId, artifactIndex } -> link.
// Idempotent: the same artifact always resolves to the same publicId, so the
// panel can call this every time "open in new tab" is clicked.
router.post('/', async (req, res, next) => {
  try {
    const { conversationId, messageId } = req.body || {};
    const artifactIndex = Number.isInteger(req.body?.artifactIndex) ? req.body.artifactIndex : 0;
    if (!mongoose.isValidObjectId(conversationId))
      return res.status(404).json({ error: 'Conversation not found' });
    if (!mongoose.isValidObjectId(messageId))
      return res.status(404).json({ error: 'Message not found in this conversation' });
    if (artifactIndex < 0 || artifactIndex > 50)
      return res.status(400).json({ error: 'Invalid artifact index' });

    // Only the chat's owner publishes from it. A public viewer of a shared chat
    // can fork it and publish from their own copy.
    const conversation = await Conversation.findById(conversationId).lean();
    if (!conversation || !ownsConversation(req, conversation))
      return res.status(404).json({ error: 'Conversation not found' });

    const message = await Message.findById(messageId).lean();
    if (!message || String(message.conversationId) !== String(conversation._id))
      return res.status(404).json({ error: 'Message not found in this conversation' });

    const artifact = extractArtifacts(message.content)[artifactIndex];
    if (!artifact) return res.status(404).json({ error: 'Artifact not found on that message' });

    const snapshot = {
      language: artifact.language,
      code: artifact.code,
      title: deriveTitle(artifact.language, artifact.code),
    };

    // An anonymous owner has no cookie, only the X-Session-Id header the API
    // client sends — and a link opened in a new tab is a plain navigation that
    // carries no headers at all. Mirror the session into a cookie so the owner
    // can still open their own private page. Nothing authorizes writes off it.
    if (!req.userId && req.sessionId)
      res.cookie(SESSION_COOKIE, req.sessionId, sessionCookieOptions());

    const existing = await Artifact.findOne({
      conversationId: conversation._id,
      messageId: message._id,
      artifactIndex,
    });
    if (existing) {
      // Re-snapshot: cheap, and it keeps a link honest if the stored message was
      // ever rewritten under it. Sharing state is deliberately left alone.
      Object.assign(existing, snapshot);
      await existing.save();
      return res.json(publicView(existing));
    }

    const owner = conversation.userId
      ? { userId: conversation.userId }
      : { sessionId: conversation.sessionId };
    const ip = clientIp(req);
    try {
      const created = await Artifact.create({
        publicId: newPublicId(),
        conversationId: conversation._id,
        messageId: message._id,
        artifactIndex,
        ...snapshot,
        ...(ip ? { ip } : {}),
        ...owner,
      });
      return res.status(201).json(publicView(created));
    } catch (err) {
      // Two clicks in flight at once: the unique index rejected the second one.
      // The first already minted the link — hand back that one.
      if (err?.code !== 11000) throw err;
      const raced = await Artifact.findOne({
        conversationId: conversation._id,
        messageId: message._id,
        artifactIndex,
      });
      if (!raced) throw err;
      return res.json(publicView(raced));
    }
  } catch (err) {
    next(err);
  }
});

// GET /api/artifacts/:publicId — link state, for the share dialog.
router.get('/:publicId', async (req, res, next) => {
  try {
    if (!isPublicId(req.params.publicId))
      return res.status(404).json({ error: 'Artifact not found' });
    const artifact = await Artifact.findOne({ publicId: req.params.publicId }).lean();
    if (!artifact || (!artifact.shared && !ownsArtifact(req, artifact)))
      return res.status(404).json({ error: 'Artifact not found' });
    res.json(publicView(artifact));
  } catch (err) {
    next(err);
  }
});

// PATCH /api/artifacts/:publicId — { shared } — the public/private switch.
router.patch('/:publicId', async (req, res, next) => {
  try {
    if (!isPublicId(req.params.publicId))
      return res.status(404).json({ error: 'Artifact not found' });
    const { shared } = req.body || {};
    if (typeof shared !== 'boolean')
      return res.status(400).json({ error: 'shared must be true or false' });

    const artifact = await Artifact.findOne({ publicId: req.params.publicId });
    // Owner-only, and a non-owner is told nothing beyond "no such link".
    if (!artifact || !ownsArtifact(req, artifact))
      return res.status(404).json({ error: 'Artifact not found' });

    artifact.shared = shared;
    artifact.sharedAt = shared ? new Date() : null;
    await artifact.save();
    res.json(publicView(artifact));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/artifacts/:publicId — retire a link entirely.
router.delete('/:publicId', async (req, res, next) => {
  try {
    if (!isPublicId(req.params.publicId))
      return res.status(404).json({ error: 'Artifact not found' });
    const artifact = await Artifact.findOne({ publicId: req.params.publicId });
    if (!artifact || !ownsArtifact(req, artifact))
      return res.status(404).json({ error: 'Artifact not found' });
    await Artifact.deleteOne({ _id: artifact._id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
