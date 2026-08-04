import mongoose from 'mongoose';
import { getModel, getCompany } from '../config/registry.js';

/**
 * Ledger of every paid model call made by the *dashboard itself*.
 *
 * The 30-day spend figure on the Overview tab is computed from `Message.usage`,
 * which only covers conversations. But two admin actions also spend the owner's
 * money — reading a pricing page with the admin LLM, and testing a provider key
 * with a live call — and neither leaves a trace in `Message`. Without this
 * collection those costs are invisible: real money with no line item.
 *
 * One document per call, whether it succeeded or not, because a failed call that
 * consumed input tokens still gets billed.
 */
const adminUsageSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: ['price_fetch', 'key_test'],
      required: true,
      index: true,
    },
    // The model that was actually called and billed.
    modelId: { type: String, default: null, index: true },
    company: { type: String, default: null },

    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    reasoningTokens: { type: Number, default: 0 },
    // Priced from the registry at call time — a later price edit must not rewrite
    // history, which is the whole point of storing the number rather than deriving it.
    costUsd: { type: Number, default: null },
    priced: { type: Boolean, default: false },

    // What the operation was about (not necessarily the model that was billed).
    targetProviderSlug: { type: String, default: null, index: true },
    targetModelSlug: { type: String, default: null },
    sourceUrl: { type: String, default: null },
    proposalId: { type: mongoose.Schema.Types.ObjectId, ref: 'PriceProposal', default: null },

    ok: { type: Boolean, default: true },
    error: { type: String, default: null },

    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    email: { type: String, lowercase: true, trim: true },
  },
  { timestamps: true }
);

adminUsageSchema.index({ createdAt: -1 });
adminUsageSchema.index({ kind: 1, createdAt: -1 });

export const AdminUsage = mongoose.model('AdminUsage', adminUsageSchema);

/**
 * Costs a usage object against the registry. Returns { costUsd, priced } with
 * costUsd null when the model carries no price — reporting 0 there would quietly
 * understate spend, which is the failure mode this whole ledger exists to avoid.
 */
export function priceUsage(modelId, usage) {
  const model = getModel(modelId);
  const hasPrice =
    Boolean(model?.price) &&
    typeof model.price.in === 'number' &&
    typeof model.price.out === 'number';

  // No usage at all means the model was never reached — a URL the SSRF guard
  // refused, or a page with no pricing on it. That is not a call that cost $0; it
  // is a call that did not happen, and `formatPrice(0)` renders as "Free", which
  // would read as "this was free" instead of "nothing was billed".
  if (!usage) return { costUsd: null, priced: hasPrice };

  if (!hasPrice) return { costUsd: null, priced: false };
  return {
    costUsd:
      ((usage.inputTokens || 0) * model.price.in + (usage.outputTokens || 0) * model.price.out) /
      1e6,
    priced: true,
  };
}

/**
 * Writes one ledger row. Fire-and-forget like `audit()`: a bookkeeping failure
 * must never break the operation the admin actually asked for, but it is logged
 * loudly because a silent gap here means under-reported spend.
 */
export function recordAdminUsage({
  kind,
  modelId,
  usage,
  targetProviderSlug = null,
  targetModelSlug = null,
  sourceUrl = null,
  proposalId = null,
  ok = true,
  error = null,
  admin = null,
}) {
  const { costUsd, priced } = priceUsage(modelId, usage);
  const model = getModel(modelId);
  return AdminUsage.create({
    kind,
    modelId: modelId || null,
    company: model?.company || null,
    inputTokens: usage?.inputTokens || 0,
    outputTokens: usage?.outputTokens || 0,
    totalTokens: usage?.totalTokens || (usage?.inputTokens || 0) + (usage?.outputTokens || 0),
    reasoningTokens: usage?.reasoningTokens || 0,
    costUsd,
    priced,
    targetProviderSlug,
    targetModelSlug,
    sourceUrl,
    proposalId,
    ok,
    error: error ? String(error).slice(0, 300) : null,
    userId: admin?._id || null,
    email: admin?.email || null,
  }).catch((err) => {
    console.error('[admin-usage] failed to record a paid admin call:', err.message);
  });
}

/** Company of a model, for display. Kept here so callers don't re-import registry. */
export function companyNameFor(modelId) {
  const model = getModel(modelId);
  return model ? getCompany(model.company)?.name || model.company : null;
}
