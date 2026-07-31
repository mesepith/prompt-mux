import crypto from 'node:crypto';
import { Otp } from '../models/Otp.js';

/**
 * A 6-digit code is only 1,000,000 possibilities, so the thing that protects an
 * account is a cap on WRONG GUESSES — without it, an attacker who triggers a
 * password reset for a known address can simply spray codes at /reset-password
 * until one lands, then set a new password and log in.
 *
 * The counter lives on the OTP document (not in memory) so it survives restarts,
 * and it is incremented with a single atomic $inc so a burst of parallel guesses
 * can't all read "attempts: 0" and slip past the limit.
 */
export const MAX_OTP_ATTEMPTS = 5;

const sameCode = (a, b) => {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
};

/**
 * Checks a submitted code against the newest OTP for (email, purpose) and, on
 * success, consumes it. Returns { ok } or { ok: false, error, reason }.
 * `reason` is for the audit log, `error` is what the user sees.
 */
export async function consumeOtp({ email, purpose, code }) {
  // One atomic increment per attempt, whatever the outcome.
  const record = await Otp.findOneAndUpdate(
    { email, purpose },
    { $inc: { attempts: 1 } },
    { new: true, sort: { createdAt: -1 } }
  );
  if (!record) return { ok: false, error: 'Invalid or expired code', reason: 'no_code' };

  if (record.expiresAt < new Date()) {
    await Otp.deleteOne({ _id: record._id });
    return { ok: false, error: 'That code has expired — request a new one.', reason: 'expired' };
  }

  if (record.attempts > MAX_OTP_ATTEMPTS) {
    await Otp.deleteOne({ _id: record._id });
    return {
      ok: false,
      error: 'Too many incorrect codes. Request a new one.',
      reason: 'too_many_attempts',
    };
  }

  if (!sameCode(record.code, code)) {
    const left = MAX_OTP_ATTEMPTS - record.attempts;
    if (left <= 0) {
      await Otp.deleteOne({ _id: record._id });
      return {
        ok: false,
        error: 'Too many incorrect codes. Request a new one.',
        reason: 'too_many_attempts',
      };
    }
    return {
      ok: false,
      error: `Incorrect code — ${left} attempt${left === 1 ? '' : 's'} left.`,
      reason: 'wrong_code',
    };
  }

  await Otp.deleteOne({ _id: record._id });
  return { ok: true };
}

/**
 * Removes every outstanding code for (email, purpose). Called before issuing a
 * new one: otherwise a caller can stack up one live code per minute against the
 * 10-minute expiry, and ten simultaneously-valid codes are ten times easier to
 * guess than one.
 */
export async function clearOtps({ email, purpose }) {
  await Otp.deleteMany({ email, purpose });
}
