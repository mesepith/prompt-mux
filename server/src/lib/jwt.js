import { SignJWT, jwtVerify } from 'jose';
import crypto from 'node:crypto';

const SECRET = () => {
  const raw = process.env.JWT_SECRET;
  if (!raw || raw.length < 16) {
    throw new Error('JWT_SECRET must be set to at least 16 characters');
  }
  return new TextEncoder().encode(raw);
};

const COOKIE_NAME = 'auth-token';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: MAX_AGE_MS,
  };
}

export function clearCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
  };
}

export async function signToken({ userId, email }) {
  return new SignJWT({ userId: String(userId), email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(SECRET());
}

export async function verifyToken(token) {
  try {
    const { payload } = await jwtVerify(token, SECRET());
    return { userId: payload.userId, email: payload.email };
  } catch {
    return null;
  }
}

export function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, cookieOptions());
}

export function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, clearCookieOptions());
}

export function readAuthCookie(req) {
  return req.cookies?.[COOKIE_NAME] || null;
}

export function generateSessionId() {
  return crypto.randomUUID();
}

export function generateOtp() {
  return String(crypto.randomInt(100000, 1000000));
}
