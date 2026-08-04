import mongoose from 'mongoose';

/**
 * One model offered by a provider. Seeded from config/seedRegistry.js, then
 * owned by the admin dashboard.
 *
 * `slug` is the id used everywhere else in the app (Conversation.modelId,
 * Message.modelId, the client's `model.id`), so it must stay stable once
 * conversations reference it — the admin API refuses to change it.
 *
 * Prices are USD per 1,000,000 tokens, matching every provider's pricing page
 * and the client's cost helper (client/src/lib/usage.js). `priceHistory` keeps
 * the last few changes so a wrong "fetch latest prices" apply can be traced and
 * reverted by hand.
 */
const priceHistorySchema = new mongoose.Schema(
  {
    in: { type: Number, default: null },
    out: { type: Number, default: null },
    cachedIn: { type: Number, default: null },
    source: { type: String, enum: ['seed', 'manual', 'fetched'], default: 'manual' },
    sourceUrl: { type: String, default: null },
    proposalId: { type: mongoose.Schema.Types.ObjectId, ref: 'PriceProposal', default: null },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    note: { type: String, default: null },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const llmModelSchema = new mongoose.Schema(
  {
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    // Provider.slug — not an ObjectId, so the registry cache and every existing
    // `model.company === 'openai'` check keep reading naturally.
    company: { type: String, required: true, lowercase: true, trim: true, index: true },
    name: { type: String, required: true, trim: true },
    apiModel: { type: String, required: true, trim: true },
    tagline: { type: String, default: null, trim: true },

    price: {
      in: { type: Number, default: null, min: 0 },
      out: { type: Number, default: null, min: 0 },
      // Cached-input rate where a provider offers one. Informational for now —
      // the cost estimate uses in/out, because that's what usage reports.
      cachedIn: { type: Number, default: null, min: 0 },
    },
    currency: { type: String, default: 'USD', uppercase: true, trim: true },
    priceSource: { type: String, enum: ['seed', 'manual', 'fetched'], default: 'seed' },
    priceUpdatedAt: { type: Date, default: null },
    priceHistory: { type: [priceHistorySchema], default: [] },

    vision: { type: Boolean, default: false },
    pdf: { type: Boolean, default: false },
    contextWindow: { type: Number, default: null, min: 0 },
    maxOutput: { type: Number, default: null, min: 0 },

    pricingUrl: { type: String, default: null, trim: true },
    notes: { type: String, default: null, trim: true },

    active: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 100 },
  },
  { timestamps: true }
);

llmModelSchema.index({ company: 1, sortOrder: 1, name: 1 });

/** Keep price history bounded — this collection is read on every boot. */
export const MAX_PRICE_HISTORY = 20;

export const LlmModel = mongoose.model('LlmModel', llmModelSchema);
