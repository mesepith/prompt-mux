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
      // Prompt-cache hits — a SUBSET of inputTokens, never an addition. Priced at
      // price.cachedIn (roughly a tenth of price.in) where a model has that rate.
      cachedInputTokens: { type: Number },
    },
    // Token usage reported by the provider (assistant messages only).
    usage: {
      inputTokens: { type: Number },
      outputTokens: { type: Number },
      totalTokens: { type: Number },
      // Prompt-cache hits — a SUBSET of inputTokens, never an addition. Priced at
      // price.cachedIn (roughly a tenth of price.in) where a model has that rate.
      cachedInputTokens: { type: Number },
      reasoningTokens: { type: Number },
    },
    // Set when generation failed (bad API key, rate limit, ...).
    error: { type: String },
    // Set on any assistant message that CHANGED an existing artifact rather than
    // writing a new one, from either surgical path:
    //   mode 'element' — point-and-edit (POST /artifact-edit); `target` is the
    //                    clicked element's label.
    //   mode 'patch'   — a plain chat message the model answered with
    //                    SEARCH/REPLACE blocks (lib/patch.js); `hunks` are the
    //                    blocks that were applied, which is what the transcript
    //                    renders as a diff.
    // `fallback` records that the cheap path did not work first time, so a turn
    // that quietly cost a full rewrite is visible rather than invisible.
    // The point-and-edit route also stamps this on its user message, to pair them.
    artifactEdit: {
      instruction: { type: String },
      target: { type: String },
      sourceMessageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
      mode: { type: String, enum: ['element', 'patch'] },
      hunks: [{ search: { type: String }, replace: { type: String } }],
      fallback: { type: String, enum: ['repair', 'rewrite'] },
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
