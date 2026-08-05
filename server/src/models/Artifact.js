import mongoose from 'mongoose';

/**
 * A published artifact — the thing behind a `/a/<publicId>` link.
 *
 * Publishing is what turns the side panel's preview into an address someone can
 * bookmark or send to a colleague. Two properties are load-bearing:
 *
 * - `publicId` is long and random, because while `shared` is false it is the
 *   only thing between a private page and someone typing URLs. Never make it
 *   derivable from the conversation or message id.
 * - `code` is a SNAPSHOT taken from the stored assistant message at publish
 *   time, never something the client sent. A client-supplied body would let
 *   anyone host arbitrary HTML on this app's own origin.
 *
 * Point & edit writes each new version as a NEW message, so one row here always
 * describes one immutable version of one artifact; re-publishing the same
 * (conversation, message, index) reuses the row and its link.
 */
const artifactSchema = new mongoose.Schema(
  {
    publicId: { type: String, required: true, unique: true, index: true },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
      index: true,
    },
    messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', required: true },
    // Which fenced block on that message — a reply can carry more than one.
    artifactIndex: { type: Number, default: 0 },
    language: { type: String, enum: ['html', 'svg'], required: true },
    title: { type: String, default: 'artifact' },
    code: { type: String, required: true },
    // Public sharing: false means only the owner can open the link.
    shared: { type: Boolean, default: false },
    sharedAt: { type: Date, default: null },
    // Ownership, mirrored from the conversation. Exactly one of these is set,
    // and mergeAnonymousSession() moves sessionId rows onto userId at login —
    // the public page authorizes against these fields, so they must not drift.
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', sparse: true, index: true },
    sessionId: { type: String, sparse: true, index: true },
    ip: { type: String, default: null },
    views: { type: Number, default: 0 },
    lastViewedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// One link per artifact version: publishing twice must not mint a second URL.
artifactSchema.index({ conversationId: 1, messageId: 1, artifactIndex: 1 }, { unique: true });

export const Artifact = mongoose.model('Artifact', artifactSchema);
