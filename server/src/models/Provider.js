import mongoose from 'mongoose';
import { ADAPTERS } from '../config/seedRegistry.js';

/**
 * An LLM company (what the chat UI calls a "company"). Seeded from
 * config/seedRegistry.js, then owned by the admin dashboard.
 *
 * `slug` is the stable id every model and conversation references — it is
 * serialized back to the client as `id`, so the wire shape the chat client has
 * always seen is unchanged.
 *
 * `apiKeyEncrypted` holds an AES-256-GCM blob (see lib/secrets.js). It is never
 * selected into any API response: the dashboard sees only `hasKey`, `keySource`
 * and `apiKeyLast4`.
 */
const providerSchema = new mongoose.Schema(
  {
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    adapter: { type: String, enum: ADAPTERS, default: 'openai' },
    // Env var consulted when no key is stored in the DB. Keeps existing
    // deployments (keys in server/.env) working untouched.
    envKey: { type: String, default: null, trim: true },
    baseURL: { type: String, default: null, trim: true },
    baseUrlEnv: { type: String, default: null, trim: true },
    requiresKey: { type: Boolean, default: true },
    color: { type: String, default: '#71717a', trim: true },

    // Credentials — write-only from the API's point of view.
    apiKeyEncrypted: { type: String, default: null, select: false },
    apiKeyLast4: { type: String, default: null },
    apiKeyUpdatedAt: { type: Date, default: null },
    apiKeyUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Result of the last "test key" call, so the dashboard can show a status
    // without hitting a paid endpoint on every page load.
    keyStatus: {
      type: String,
      enum: ['unknown', 'ok', 'failed'],
      default: 'unknown',
    },
    keyStatusMessage: { type: String, default: null },
    keyCheckedAt: { type: Date, default: null },

    pricingUrl: { type: String, default: null, trim: true },
    docsUrl: { type: String, default: null, trim: true },
    notes: { type: String, default: null, trim: true },

    active: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 100 },
  },
  { timestamps: true }
);

providerSchema.index({ sortOrder: 1, name: 1 });

export const Provider = mongoose.model('Provider', providerSchema);
