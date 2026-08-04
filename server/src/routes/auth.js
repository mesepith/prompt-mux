import { Router } from 'express';
import { User } from '../models/User.js';
import { Otp } from '../models/Otp.js';
import { hashPassword, verifyPassword, isPasswordStrong } from '../lib/password.js';
import { signToken, setAuthCookie, clearAuthCookie, generateOtp } from '../lib/jwt.js';
import { sendOtpEmail } from '../lib/email.js';
import {
  canSendOtp,
  recordOtpSent,
  hitLimit,
  clearLimit,
  LOGIN_LIMIT,
  LOGIN_IP_LIMIT,
  OTP_ATTEMPT_IP_LIMIT,
} from '../lib/rateLimit.js';
import { consumeOtp, clearOtps } from '../lib/otp.js';
import { isRegistrationAllowed } from '../config/access.js';
import { applyBootstrapAdmin } from '../middleware/requireAdmin.js';
import { adminPathSegment } from '../config/adminPath.js';
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
    // The client shows the Admin link off this field. Authorization itself is
    // re-checked server-side on every /api/admin request (middleware/requireAdmin.js),
    // so a tampered client can only reveal a link, never a capability.
    role: user.role || 'user',
    createdAt: user.createdAt,
  };
}

/**
 * The body returned by every endpoint that signs someone in. `adminPath` — the
 * dashboard's private URL segment — is included ONLY for an admin, and this is
 * the only channel through which the client ever learns it. Kept in one helper so
 * login, verification and password reset can't drift apart on that rule.
 */
function authPayload(user) {
  return {
    user: publicUser(user),
    ...(user.role === 'admin' ? { adminPath: adminPathSegment() } : {}),
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
      // Reuse the code, but still SEND it. Previously this returned early, so a
      // user whose first email never arrived was told "code sent" every time and
      // could never get one — the audit log claimed success too.
      const rate = canSendOtp(email);
      if (!rate.ok) {
        const err = new Error(
          `Please wait ${Math.ceil(rate.retryAfterMs / 1000)} seconds before requesting another code.`
        );
        err.status = 429;
        throw err;
      }
      recordOtpSent(email);
      try {
        await sendOtpEmail({ email, code: existing.code, purpose });
        audit({ event: 'otp_sent', userId, email, sessionId, req, metadata: { ...metadata, reused: true } });
      } catch (err) {
        audit({
          event: 'otp_send_failed',
          userId,
          email,
          sessionId,
          req,
          metadata: { error: err.message, purpose, reused: true, ...metadata },
        });
        throw err;
      }
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
      const user = await User.findById(req.userId);
      if (!user) {
        clearAuthCookie(res);
        return res.json({ user: null, anonymous: await anonymousUsage(req.sessionId) });
      }
      // Promote here too: an admin listed in ADMIN_EMAILS who already has a
      // valid cookie never hits the login path again, and would otherwise never
      // see the dashboard link.
      await applyBootstrapAdmin(user, req);
      return res.json({ ...authPayload(user), anonymous: null });
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

    if (!isRegistrationAllowed(normalized)) {
      audit({ event: 'registration_blocked', email: normalized, sessionId, req });
      return res.status(403).json({ error: 'Registration is closed on this server.' });
    }

    const existing = await User.findOne({ email: normalized });
    if (existing) {
      if (existing.verified) {
        return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });
      }
      // Unverified: resend the code so the real owner of the inbox can finish
      // signing up. Do NOT touch the stored password — this endpoint is
      // unauthenticated, so overwriting it let anyone who knew a pending email
      // set their own password and take the account over the moment its owner
      // verified with the code that was mailed to them.
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

    const ipLimit = hitLimit(`otp-verify:${req.ip}`, OTP_ATTEMPT_IP_LIMIT);
    if (!ipLimit.ok) {
      audit({ event: 'rate_limited', email: normalized, sessionId, req, metadata: { route: 'verify-email' } });
      return res.status(429).json({
        error: `Too many attempts. Try again in ${Math.ceil(ipLimit.retryAfterMs / 1000)} seconds.`,
      });
    }

    const user = await User.findOne({ email: normalized });
    if (!user) return res.status(404).json({ error: 'Account not found' });

    const result = await consumeOtp({ email: normalized, purpose: 'register', code });
    if (!result.ok) {
      audit({
        event: 'otp_failed',
        userId: user._id,
        email: normalized,
        sessionId,
        req,
        metadata: { purpose: 'register', reason: result.reason },
      });
      return res.status(400).json({ error: result.error });
    }

    user.verified = true;
    await user.save();
    await mergeAnonymousSession({ sessionId, userId: user._id });

    const token = await signToken({ userId: user._id, email: user.email });
    setAuthCookie(res, token);
    audit({ event: 'email_verified', userId: user._id, email: user.email, sessionId, req });
    await applyBootstrapAdmin(user, req);

    res.json(authPayload(user));
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

    // Two limits: per account so guessing one password is slow, and per IP so one
    // source can't work through many accounts. Without these, a public instance
    // allows unlimited online guessing — and each attempt costs a bcrypt hash,
    // which is its own CPU exhaustion problem on a 1 GB box.
    const perEmail = hitLimit(`login:${normalized}`, LOGIN_LIMIT);
    const perIp = hitLimit(`login-ip:${req.ip}`, LOGIN_IP_LIMIT);
    if (!perEmail.ok || !perIp.ok) {
      const retryAfterMs = Math.max(perEmail.retryAfterMs, perIp.retryAfterMs);
      audit({
        event: 'rate_limited',
        email: normalized,
        sessionId,
        req,
        metadata: { route: 'login', scope: perEmail.ok ? 'ip' : 'email' },
      });
      return res.status(429).json({
        error: `Too many login attempts. Try again in ${Math.ceil(retryAfterMs / 60000)} minute(s).`,
      });
    }

    const user = await User.findOne({ email: normalized });
    if (!user) {
      audit({ event: 'login_failed', email: normalized, sessionId, req, metadata: { reason: 'no_account' } });
      return res.status(401).json({
        error: "Invalid email or password. If you haven't signed up yet, create an account.",
      });
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      audit({
        event: 'login_failed',
        userId: user._id,
        email: normalized,
        sessionId,
        req,
        metadata: { reason: 'bad_password' },
      });
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
    clearLimit(`login:${normalized}`); // a success shouldn't leave the account throttled
    audit({ event: 'user_login', userId: user._id, email: user.email, sessionId, req });
    await applyBootstrapAdmin(user, req);

    res.json(authPayload(user));
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
      // Say so, instead of returning a fake success. The old non-disclosure was
      // cosmetic — /register already answers 409 for a known email, so anyone can
      // enumerate accounts anyway — while the fake 200 sent the user to a
      // "enter the code we emailed you" screen for a code that was never sent,
      // where Resend then answered 404. That dead end is what this fixes.
      return res.status(404).json({
        error: 'No account uses that email. Create an account instead.',
        noAccount: true,
      });
    }

    const rate = canSendOtp(normalized);
    if (!rate.ok) {
      return res.status(429).json({
        error: `Please wait ${Math.ceil(rate.retryAfterMs / 1000)} seconds before requesting another code.`,
      });
    }

    // Drop any earlier codes first: one live code per minute against a 10-minute
    // expiry meant ~10 valid codes at once, i.e. ten times easier to guess.
    await clearOtps({ email: normalized, purpose: 'forgot-password' });
    const code = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);
    await Otp.create({ email: normalized, code, purpose: 'forgot-password', expiresAt });
    recordOtpSent(normalized);

    try {
      await sendOtpEmail({ email: normalized, code, purpose: 'forgot-password' });
    } catch (err) {
      // Don't leave a code the user never received sitting there as a guess target.
      await clearOtps({ email: normalized, purpose: 'forgot-password' });
      audit({
        event: 'otp_send_failed',
        userId: user._id,
        email: normalized,
        sessionId: req.sessionId,
        req,
        metadata: { error: err.message, purpose: 'forgot-password' },
      });
      return res.status(502).json({ error: 'Could not send the email. Please try again.' });
    }
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

    const ipLimit = hitLimit(`otp-verify:${req.ip}`, OTP_ATTEMPT_IP_LIMIT);
    if (!ipLimit.ok) {
      audit({ event: 'rate_limited', email: normalized, sessionId, req, metadata: { route: 'reset-password' } });
      return res.status(429).json({
        error: `Too many attempts. Try again in ${Math.ceil(ipLimit.retryAfterMs / 1000)} seconds.`,
      });
    }

    const user = await User.findOne({ email: normalized });
    if (!user) return res.status(404).json({ error: 'Account not found' });

    const result = await consumeOtp({ email: normalized, purpose: 'forgot-password', code });
    if (!result.ok) {
      audit({
        event: 'otp_failed',
        userId: user._id,
        email: normalized,
        sessionId,
        req,
        metadata: { purpose: 'forgot-password', reason: result.reason },
      });
      return res.status(400).json({ error: result.error });
    }

    user.passwordHash = await hashPassword(password);
    user.verified = true;
    await user.save();
    clearLimit(`login:${normalized}`);
    await mergeAnonymousSession({ sessionId, userId: user._id });

    const token = await signToken({ userId: user._id, email: user.email });
    setAuthCookie(res, token);
    audit({ event: 'password_reset', userId: user._id, email: user.email, sessionId, req });
    await applyBootstrapAdmin(user, req);

    res.json(authPayload(user));
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
    if (!user) {
      return res.status(404).json({
        error: 'No account uses that email. Create an account instead.',
        noAccount: true,
      });
    }

    // Answer "already verified" BEFORE the throttle: telling a verified user to
    // wait 60 seconds for a code they don't need is a dead end.
    if (purpose === 'register' && user.verified) {
      return res.status(400).json({ error: 'This email is already verified. Please log in.' });
    }

    const rate = canSendOtp(normalized);
    if (!rate.ok) {
      return res.status(429).json({
        error: `Please wait ${Math.ceil(rate.retryAfterMs / 1000)} seconds before requesting another code.`,
      });
    }

    await clearOtps({ email: normalized, purpose });

    const code = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);
    await Otp.create({ email: normalized, code, purpose, expiresAt });
    recordOtpSent(normalized);

    try {
      await sendOtpEmail({ email: normalized, code, purpose });
    } catch (err) {
      // The old code left the fresh OTP in place and reported a 500, so the user
      // had a live code they never received — and a burned rate limiter.
      await clearOtps({ email: normalized, purpose });
      audit({
        event: 'otp_send_failed',
        userId: user._id,
        email: normalized,
        sessionId: req.sessionId,
        req,
        metadata: { error: err.message, purpose, resend: true },
      });
      return res.status(502).json({ error: 'Could not send the email. Please try again.' });
    }
    audit({ event: 'otp_sent', userId: user._id, email: normalized, sessionId: req.sessionId, req, metadata: { resend: true, purpose } });

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
