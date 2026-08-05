import crypto from 'node:crypto';

/**
 * Identity bits for published artifacts (`/a/<publicId>`).
 */

// 12 random bytes -> 16 URL-safe characters, ~96 bits. While an artifact is
// private its id is the whole access control, so this must never shrink to
// something short or sequential.
export function newPublicId() {
  return crypto.randomBytes(12).toString('base64url');
}

export function isPublicId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,32}$/.test(value);
}

/**
 * Anonymous-owner cookie.
 *
 * Anonymous users are identified by the `X-Session-Id` header the API client
 * sends, but opening a link in a new tab is a plain navigation with no headers,
 * so the owner of a private artifact would 404 on their own page. This cookie
 * mirrors the same value. It is read in exactly one place — the `/a/<id>` page,
 * to decide whether to show a not-yet-shared artifact — and never authorizes a
 * write; the API keeps using the header.
 */
export const SESSION_COOKIE = 'pm-session';

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 180 * 24 * 60 * 60 * 1000, // 180 days — outlives a browsing session
    path: '/',
  };
}

export function readSessionCookie(req) {
  const value = req.cookies?.[SESSION_COOKIE];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
