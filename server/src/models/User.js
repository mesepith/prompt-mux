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
  },
  { timestamps: true }
);

export const User = mongoose.model('User', userSchema);
