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
  },
  { timestamps: true }
);

// Auto-remove expired OTPs.
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Otp = mongoose.model('Otp', otpSchema);
