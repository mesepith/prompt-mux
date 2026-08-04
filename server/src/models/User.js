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
  },
  { timestamps: true }
);

export const User = mongoose.model('User', userSchema);
