import mongoose from 'mongoose';

/**
 * The output of one "fetch latest prices" run — a *proposal*, never a write.
 *
 * Prices drive the cost figures every user sees, so an LLM reading a pricing
 * page is treated as a suggestion that an admin approves row by row. The
 * proposal keeps what was on the page, what the extractor made of it, and what
 * the registry said at the time, so the dashboard can render a real diff.
 */
const proposalItemSchema = new mongoose.Schema(
  {
    // Registry model this row was matched to (null when the page lists a model
    // we don't have — surfaced as "not in registry", optionally added by hand).
    modelSlug: { type: String, default: null },
    matchedBy: { type: String, enum: ['slug', 'apiModel', 'name', null], default: null },

    // As it appeared on the page.
    label: { type: String, default: null },
    apiModel: { type: String, default: null },
    unit: { type: String, default: null },
    currency: { type: String, default: 'USD' },

    inPrice: { type: Number, default: null },
    outPrice: { type: Number, default: null },
    cachedInPrice: { type: Number, default: null },

    // Registry snapshot at fetch time, so the diff survives later edits.
    currentIn: { type: Number, default: null },
    currentOut: { type: Number, default: null },

    confidence: { type: Number, default: null, min: 0, max: 1 },
    evidence: { type: String, default: null },
    applied: { type: Boolean, default: false },
    appliedAt: { type: Date, default: null },
  },
  { _id: true }
);

const priceProposalSchema = new mongoose.Schema(
  {
    scope: { type: String, enum: ['provider', 'model'], required: true },
    providerSlug: { type: String, required: true, index: true },
    modelSlug: { type: String, default: null },

    sourceUrl: { type: String, required: true },
    // Which model did the extraction, and how big the page was — useful when a
    // run comes back nonsense and you need to know what to blame.
    adminModelId: { type: String, default: null },
    pageChars: { type: Number, default: null },
    usedChars: { type: Number, default: null },
    truncated: { type: Boolean, default: false },

    status: {
      type: String,
      enum: ['ready', 'failed', 'applied', 'partially-applied', 'discarded'],
      default: 'ready',
      index: true,
    },
    items: { type: [proposalItemSchema], default: [] },
    warnings: { type: [String], default: [] },
    error: { type: String, default: null },
    // Trimmed model output, kept for debugging a bad extraction.
    rawExcerpt: { type: String, default: null },
    usage: { type: mongoose.Schema.Types.Mixed, default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    appliedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    appliedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

priceProposalSchema.index({ createdAt: -1 });

export const PriceProposal = mongoose.model('PriceProposal', priceProposalSchema);
