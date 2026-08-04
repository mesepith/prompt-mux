import mongoose from 'mongoose';

const auditLogSchema = new mongoose.Schema(
  {
    event: {
      type: String,
      enum: [
        'otp_sent',
        'otp_send_failed',
        'user_registered',
        'email_verified',
        'user_login',
        'login_failed',
        'password_reset',
        'logout',
        'anonymous_limit_reached',
        // Abuse signals: without these, password guessing and code guessing on a
        // publicly reachable instance leave no trace at all.
        'otp_failed',
        'rate_limited',
        'registration_blocked',
        // Admin dashboard. Every change to the LLM registry, and every touch of a
        // provider API key, is traceable to a person — these routes can spend
        // money and can switch models off for every user.
        'admin_granted',
        'admin_forbidden',
        'admin_provider_created',
        'admin_provider_updated',
        'admin_provider_deleted',
        'admin_model_created',
        'admin_model_updated',
        'admin_model_deleted',
        'admin_key_set',
        'admin_key_cleared',
        'admin_key_tested',
        'admin_models_discovered',
        'admin_price_fetched',
        'admin_price_applied',
        'admin_price_discarded',
        'admin_settings_updated',
        'admin_registry_reseeded',
      ],
      required: true,
      index: true,
    },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    email: { type: String, lowercase: true, trim: true, index: true },
    sessionId: { type: String, index: true },
    ip: { type: String },
    userAgent: { type: String },
    metadata: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ event: 1, createdAt: -1 });

export const AuditLog = mongoose.model('AuditLog', auditLogSchema);

export function audit({ event, userId, email, sessionId, req, metadata }) {
  AuditLog.create({
    event,
    userId,
    email,
    sessionId,
    ip: req?.ip || req?.headers?.['x-forwarded-for'] || null,
    userAgent: req?.headers?.['user-agent'] || null,
    metadata,
  }).catch((err) => {
    console.error('[audit] failed to write log:', err.message);
  });
}
