import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    passwordHash: { type: String, required: true },
    verified: { type: Boolean, default: false },
    // Admins reach /admin — the LLM company/model/pricing/key dashboard.
    // Bootstrap the first one with ADMIN_EMAILS in server/.env (see
    // config/access.js#isBootstrapAdmin) or `npm --prefix server run make-admin`.
    role: { type: String, enum: ['user', 'admin'], default: 'user', index: true },
    // Where the account was created, and where it was last signed in from.
    // Stored for abuse investigation and usage attribution; AuditLog already keeps
    // a per-event history, these two are the summary the admin lists show.
    signupIp: { type: String, default: null },
    lastIp: { type: String, default: null },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const User = mongoose.model('User', userSchema);
