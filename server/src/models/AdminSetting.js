import mongoose from 'mongoose';

/**
 * Singleton settings document for the admin dashboard (`key: 'global'`).
 *
 * `adminModelId` is the "admin LLM": the model used to read pricing pages and
 * extract prices from them. It should be a cheap, reliable, long-context model —
 * it never talks to end users. Falls back to the ADMIN_LLM_MODEL env var, then
 * to the first available non-demo model.
 */
const adminSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'global' },
    // URL segment the dashboard is served from, so it isn't sitting on /admin.
    // Generated on first boot when ADMIN_PATH isn't set — see config/adminPath.js.
    adminPath: { type: String, default: null },
    adminModelId: { type: String, default: null },
    // Hard cap on how much page text is handed to the admin model. A pricing
    // page is mostly navigation chrome; 60k characters is already generous and
    // keeps a fetch from costing real money.
    fetchMaxChars: { type: Number, default: 60_000, min: 2_000, max: 400_000 },
    // When true (the default), fetched prices always land as a proposal that an
    // admin approves. Turning it off lets a fetch apply straight away.
    requireApproval: { type: Boolean, default: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

export const AdminSetting = mongoose.model('AdminSetting', adminSettingSchema);

/**
 * Reads the singleton, creating it on first access. Upsert rather than
 * find-then-create: two admin requests arriving together would otherwise both
 * see "missing" and race on the unique index.
 */
export async function getAdminSettings() {
  return AdminSetting.findOneAndUpdate(
    { key: 'global' },
    { $setOnInsert: { key: 'global' } },
    { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true }
  );
}
