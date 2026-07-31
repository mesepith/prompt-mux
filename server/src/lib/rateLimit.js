/**
 * In-process rate limiting for the auth routes.
 *
 * Deliberately simple: a single PM2 fork instance serves this app (SSE streams are
 * stateful per process), so a Map is enough. It is NOT durable — a restart clears
 * every counter — so treat these limits as abuse friction, not as a security
 * boundary. The per-code attempt counter in lib/otp.js is the durable one, because
 * that's the limit that actually protects an account.
 */

const buckets = new Map(); // key -> { hits: number[], expires: number }
const otpSends = new Map(); // email -> timestamp of last send
const OTP_SEND_WINDOW_MS = 60_000;
const SWEEP_EVERY_MS = 5 * 60_000;

let lastSweep = Date.now();

/** Drops stale entries so the maps can't grow without bound. */
function sweep(now) {
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) if (bucket.expires <= now) buckets.delete(key);
  for (const [email, at] of otpSends) if (now - at > OTP_SEND_WINDOW_MS) otpSends.delete(email);
}

/**
 * Records one attempt against `key` and reports whether it is still allowed.
 * Sliding window: at most `max` attempts per `windowMs`.
 */
export function hitLimit(key, { max, windowMs }) {
  const now = Date.now();
  sweep(now);
  const bucket = buckets.get(key) || { hits: [], expires: now + windowMs };
  bucket.hits = bucket.hits.filter((at) => now - at < windowMs);
  bucket.hits.push(now);
  bucket.expires = now + windowMs;
  buckets.set(key, bucket);
  const ok = bucket.hits.length <= max;
  const oldest = bucket.hits[0];
  return {
    ok,
    remaining: Math.max(0, max - bucket.hits.length),
    retryAfterMs: ok ? 0 : Math.max(0, windowMs - (now - oldest)),
  };
}

/** Forgets a key — call after a success so one bad streak doesn't linger. */
export function clearLimit(key) {
  buckets.delete(key);
}

export function canSendOtp(email) {
  const now = Date.now();
  sweep(now);
  const key = email.toLowerCase().trim();
  const last = otpSends.get(key);
  if (last && now - last < OTP_SEND_WINDOW_MS) {
    return { ok: false, retryAfterMs: OTP_SEND_WINDOW_MS - (now - last) };
  }
  return { ok: true };
}

export function recordOtpSent(email) {
  otpSends.set(email.toLowerCase().trim(), Date.now());
}

export function clearOtpRateLimit(email) {
  otpSends.delete(email.toLowerCase().trim());
}

// Limits used by the auth routes. Login is keyed per email AND per IP so one
// noisy address can't lock out everyone, and so guessing one account is slow.
export const LOGIN_LIMIT = { max: 8, windowMs: 15 * 60_000 };
export const LOGIN_IP_LIMIT = { max: 40, windowMs: 15 * 60_000 };
export const OTP_ATTEMPT_IP_LIMIT = { max: 25, windowMs: 10 * 60_000 };
