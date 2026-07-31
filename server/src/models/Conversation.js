import mongoose from 'mongoose';

const conversationSchema = new mongoose.Schema(
  {
    title: { type: String, default: 'New chat' },
    // The currently selected model for this conversation. Users can switch
    // models mid-conversation; each assistant message also stores its own modelId.
    modelId: { type: String, required: true },
    // Optional: vision-capable model used ONLY to describe attached images when
    // the selected chat model has no image support (two-model setup).
    visionModelId: { type: String },
    lastMessageAt: { type: Date, default: Date.now },
    // Ownership. Exactly one of userId or sessionId is set.
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', sparse: true, index: true },
    sessionId: { type: String, sparse: true, index: true },
  },
  { timestamps: true }
);

conversationSchema.index({ lastMessageAt: -1 });

export const Conversation = mongoose.model('Conversation', conversationSchema);
