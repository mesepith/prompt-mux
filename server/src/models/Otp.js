import mongoose from 'mongoose';

const otpSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    code: { type: String, required: true },
    purpose: {
      type: String,
      enum: ['register', 'forgot-password'],
      required: true,
    },
    expiresAt: { type: Date, required: true },
    // Wrong guesses against this code. Capped in lib/otp.js — a 6-digit code with
    // unlimited attempts is a brute-forceable account takeover.
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Auto-remove expired OTPs.
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Otp = mongoose.model('Otp', otpSchema);
