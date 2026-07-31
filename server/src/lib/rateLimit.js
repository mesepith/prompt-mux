const lastSent = new Map();
const WINDOW_MS = 60_000;

export function canSendOtp(email) {
  const now = Date.now();
  const key = email.toLowerCase().trim();
  const last = lastSent.get(key);
  if (last && now - last < WINDOW_MS) {
    return { ok: false, retryAfterMs: WINDOW_MS - (now - last) };
  }
  return { ok: true };
}

export function recordOtpSent(email) {
  lastSent.set(email.toLowerCase().trim(), Date.now());
}

export function clearOtpRateLimit(email) {
  lastSent.delete(email.toLowerCase().trim());
}
