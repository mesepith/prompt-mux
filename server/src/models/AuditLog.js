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
        'password_reset',
        'logout',
        'anonymous_limit_reached',
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
