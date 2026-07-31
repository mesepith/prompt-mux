import { Router } from 'express';
import { User } from '../models/User.js';
import { Otp } from '../models/Otp.js';
import { hashPassword, verifyPassword, isPasswordStrong } from '../lib/password.js';
import { signToken, setAuthCookie, clearAuthCookie, generateOtp } from '../lib/jwt.js';
import { sendOtpEmail } from '../lib/email.js';
import { canSendOtp, recordOtpSent } from '../lib/rateLimit.js';
import { mergeAnonymousSession } from '../lib/sessionMerge.js';
import { Message } from '../models/Message.js';
import { audit } from '../models/AuditLog.js';

const router = Router();

const OTP_EXPIRY_MINUTES = Number(process.env.OTP_EXPIRY_MINUTES) || 10;
const ANONYMOUS_MESSAGE_LIMIT = Number(process.env.ANONYMOUS_MESSAGE_LIMIT) || 3;

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function publicUser(user) {
  return {
    _id: user._id,
    email: user.email,
    verified: user.verified,
    createdAt: user.createdAt,
  };
}

/**
 * Reuse an existing valid registration OTP if one exists; otherwise generate a
 * new code, send it, and return it. `forceNew` bypasses reuse so explicit
 * resend always delivers a fresh code.
 */
async function sendOrReuseRegisterOtp({ email, purpose, req, userId, sessionId, forceNew = false, metadata = {} }) {
  if (!forceNew) {
    const existing = await Otp.findOne({ email, purpose, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
    if (existing) {
      audit({ event: 'otp_sent', userId, email, sessionId, req, metadata: { ...metadata, reused: true } });
      return existing.code;
    }
  }

  const rate = canSendOtp(email);
  if (!rate.ok) {
    const err = new Error(`Please wait ${Math.ceil(rate.retryAfterMs / 1000)} seconds before requesting another code.`);
    err.status = 429;
    throw err;
  }

  await Otp.deleteMany({ email, purpose });
  const code = generateOtp();
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);
  await Otp.create({ email, code, purpose, expiresAt });
  recordOtpSent(email);

  try {
    await sendOtpEmail({ email, code, purpose });
    audit({ event: 'otp_sent', userId, email, sessionId, req, metadata });
  } catch (err) {
    await Otp.deleteOne({ email, purpose });
    audit({ event: 'otp_send_failed', userId, email, sessionId, req, metadata: { error: err.message, purpose, ...metadata } });
    throw err;
  }
  return code;
}

async function anonymousUsage(sessionId) {
  if (!sessionId) return { messageCount: 0, limit: ANONYMOUS_MESSAGE_LIMIT, blocked: false };
    const messageCount = await Message.countDocuments({ sessionId, role: 'user' });
  return {
    messageCount,
    limit: ANONYMOUS_MESSAGE_LIMIT,
    blocked: messageCount >= ANONYMOUS_MESSAGE_LIMIT,
  };
}

router.get('/me', async (req, res, next) => {
  try {
    if (req.userId) {
      const user = await User.findById(req.userId).lean();
      if (!user) {
        clearAuthCookie(res);
        return res.json({ user: null, anonymous: await anonymousUsage(req.sessionId) });
      }
      return res.json({ user: publicUser(user), anonymous: null });
    }
    return res.json({ user: null, anonymous: await anonymousUsage(req.sessionId) });
  } catch (err) {
    next(err);
  }
});

router.post('/register', async (req, res, next) => {
  try {
    const { email, password, sessionId } = req.body || {};
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Valid email is required' });
    if (!isPasswordStrong(password)) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const normalized = email.trim().toLowerCase();

    const existing = await User.findOne({ email: normalized });
    if (existing) {
      if (existing.verified) {
        return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });
      }
      // Unverified: let the user continue signup with a new password and reuse/send OTP.
      existing.passwordHash = await hashPassword(password);
      await existing.save();
      try {
        await sendOrReuseRegisterOtp({
          email: normalized,
          purpose: 'register',
          req,
          userId: existing._id,
          sessionId,
          metadata: { context: 'signup_continue' },
        });
      } catch (err) {
        return res.status(err.status || 500).json({ error: err.message });
      }
      return res.json({ ok: true, email: normalized, requiresVerification: true });
    }

    const passwordHash = await hashPassword(password);
    const user = await User.create({ email: normalized, passwordHash, verified: false });

    try {
      await sendOrReuseRegisterOtp({
        email: normalized,
        purpose: 'register',
        req,
        userId: user._id,
        sessionId,
        metadata: { context: 'signup' },
      });
      audit({ event: 'user_registered', userId: user._id, email: normalized, sessionId, req });
    } catch (err) {
      // Roll back so the user can retry.
      await User.findByIdAndDelete(user._id);
      return res.status(err.status || 500).json({ error: err.message });
    }

    res.json({ ok: true, email: normalized, requiresVerification: true });
  } catch (err) {
    next(err);
  }
});

router.post('/verify-email', async (req, res, next) => {
  try {
    const { email, otp, sessionId } = req.body || {};
    if (!isValidEmail(email) || typeof otp !== 'string' || !otp.trim()) {
      return res.status(400).json({ error: 'Email and OTP are required' });
    }
    const normalized = email.trim().toLowerCase();
    const code = otp.trim();

    const user = await User.findOne({ email: normalized });
    if (!user) return res.status(404).json({ error: 'Account not found' });

    const record = await Otp.findOne({ email: normalized, purpose: 'register', code });
    if (!record || record.expiresAt < new Date()) {
      return res.status(400).json({ error: 'Invalid or expired code' });
    }

    user.verified = true;
    await user.save();
    await Otp.deleteOne({ _id: record._id });
    await mergeAnonymousSession({ sessionId, userId: user._id });

    const token = await signToken({ userId: user._id, email: user.email });
    setAuthCookie(res, token);
    audit({ event: 'email_verified', userId: user._id, email: user.email, sessionId, req });

    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password, sessionId } = req.body || {};
    if (!isValidEmail(email) || typeof password !== 'string' || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const normalized = email.trim().toLowerCase();

    const user = await User.findOne({ email: normalized });
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({
        error: 'Invalid email or password. If you forgot your password, use Forgot password.',
      });
    }

    if (!user.verified) {
      try {
        await sendOrReuseRegisterOtp({
          email: normalized,
          purpose: 'register',
          req,
          userId: user._id,
          sessionId,
          metadata: { context: 'login_unverified' },
        });
      } catch (err) {
        return res.status(err.status || 500).json({ error: err.message });
      }
      return res.json({ ok: true, email: normalized, requiresVerification: true });
    }

    await mergeAnonymousSession({ sessionId, userId: user._id });

    const token = await signToken({ userId: user._id, email: user.email });
    setAuthCookie(res, token);
    audit({ event: 'user_login', userId: user._id, email: user.email, sessionId, req });

    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/forgot-password', async (req, res, next) => {
  try {
    const { email, sessionId } = req.body || {};
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Valid email is required' });
    const normalized = email.trim().toLowerCase();

    const user = await User.findOne({ email: normalized });
    if (!user) {
      // Don't reveal whether the email exists.
      return res.json({ ok: true, email: normalized });
    }

    const rate = canSendOtp(normalized);
    if (!rate.ok) {
      return res.status(429).json({
        error: `Please wait ${Math.ceil(rate.retryAfterMs / 1000)} seconds before requesting another code.`,
      });
    }

    const code = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);
    await Otp.create({ email: normalized, code, purpose: 'forgot-password', expiresAt });
    recordOtpSent(normalized);

    await sendOtpEmail({ email: normalized, code, purpose: 'forgot-password' });
    audit({ event: 'otp_sent', userId: user._id, email: normalized, sessionId: req.sessionId, req });

    res.json({ ok: true, email: normalized });
  } catch (err) {
    next(err);
  }
});

router.post('/reset-password', async (req, res, next) => {
  try {
    const { email, otp, password, sessionId } = req.body || {};
    if (!isValidEmail(email) || typeof otp !== 'string' || !otp.trim()) {
      return res.status(400).json({ error: 'Email and OTP are required' });
    }
    if (!isPasswordStrong(password)) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const normalized = email.trim().toLowerCase();
    const code = otp.trim();

    const user = await User.findOne({ email: normalized });
    if (!user) return res.status(404).json({ error: 'Account not found' });

    const record = await Otp.findOne({ email: normalized, purpose: 'forgot-password', code });
    if (!record || record.expiresAt < new Date()) {
      return res.status(400).json({ error: 'Invalid or expired code' });
    }

    user.passwordHash = await hashPassword(password);
    user.verified = true;
    await user.save();
    await Otp.deleteOne({ _id: record._id });
    await mergeAnonymousSession({ sessionId, userId: user._id });

    const token = await signToken({ userId: user._id, email: user.email });
    setAuthCookie(res, token);
    audit({ event: 'password_reset', userId: user._id, email: user.email, sessionId, req });

    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/resend', async (req, res, next) => {
  try {
    const { email, purpose } = req.body || {};
    if (!isValidEmail(email) || !['register', 'forgot-password'].includes(purpose)) {
      return res.status(400).json({ error: 'Email and valid purpose are required' });
    }
    const normalized = email.trim().toLowerCase();

    const user = await User.findOne({ email: normalized });
    if (!user) return res.status(404).json({ error: 'Account not found' });

    const rate = canSendOtp(normalized);
    if (!rate.ok) {
      return res.status(429).json({
        error: `Please wait ${Math.ceil(rate.retryAfterMs / 1000)} seconds before requesting another code.`,
      });
    }

    if (purpose === 'register' && user.verified) {
      return res.status(400).json({ error: 'This email is already verified. Please log in.' });
    }

    await Otp.deleteMany({ email: normalized, purpose });

    const code = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);
    await Otp.create({ email: normalized, code, purpose, expiresAt });
    recordOtpSent(normalized);

    await sendOtpEmail({ email: normalized, code, purpose });
    audit({ event: 'otp_sent', userId: user?._id, email: normalized, sessionId: req.sessionId, req, metadata: { resend: true, purpose } });

    res.json({ ok: true, email: normalized });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  audit({ event: 'logout', userId: req.userId, email: req.userEmail, sessionId: req.sessionId, req });
  res.json({ ok: true });
});

export default router;
