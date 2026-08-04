import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
      index: true,
    },
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, default: '' },
    // Which model produced this message (assistant messages only).
    modelId: { type: String },
    // Attachments (user messages only). Images store the data URL;
    // PDFs store the extracted text (kind: 'pdf'), not the binary.
    attachments: [
      {
        kind: { type: String, enum: ['image', 'pdf', 'doc'], default: 'image' },
        dataUrl: { type: String },
        mimeType: { type: String },
        name: { type: String },
        pageCount: { type: Number },
        textContent: { type: String },
        // true when the PDF had no text layer and textContent came from a
        // vision model reading rendered page images
        scanned: { type: Boolean },
      },
    ],
    // Set on assistant messages when a separate vision model described the
    // images (two-model setup): which model + its token usage.
    visionUsage: {
      modelId: { type: String },
      inputTokens: { type: Number },
      outputTokens: { type: Number },
      totalTokens: { type: Number },
    },
    // Token usage reported by the provider (assistant messages only).
    usage: {
      inputTokens: { type: Number },
      outputTokens: { type: Number },
      totalTokens: { type: Number },
      reasoningTokens: { type: Number },
    },
    // Set when generation failed (bad API key, rate limit, ...).
    error: { type: String },
    // Set on the message pair produced by point-and-edit (POST /artifact-edit):
    // the user's instruction, the element it targeted, and the message whose
    // artifact was edited. Used to badge the pair in the UI and to trim older
    // edit copies out of provider history.
    artifactEdit: {
      instruction: { type: String },
      target: { type: String },
      sourceMessageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
    },
    // Ownership. Mirrors the parent conversation's owner.
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', sparse: true, index: true },
    sessionId: { type: String, sparse: true, index: true },
    // Where the request came from, normalized by lib/clientIp.js. Recorded per
    // message rather than only per conversation because a chat can be continued
    // from a different network, and attribution follows the request that spent
    // the tokens. Personal data — see the note in lib/clientIp.js.
    ip: { type: String, default: null, index: true },
  },
  { timestamps: true }
);

export const Message = mongoose.model('Message', messageSchema);
