import { User } from '../models/User.js';
import { isBootstrapAdmin } from '../config/access.js';
import { audit } from '../models/AuditLog.js';

/**
 * Gate for everything under /api/admin.
 *
 * The role is read from MongoDB on every request rather than from the JWT, so
 * revoking someone's admin takes effect immediately instead of whenever their
 * 7-day cookie happens to expire. That's one extra indexed lookup on admin
 * routes only — the chat path is untouched.
 *
 * ADMIN_EMAILS acts as a bootstrap: the first time a listed address signs in,
 * it is promoted, so a fresh install has an admin without a manual DB edit.
 */
export async function requireAdmin(req, res, next) {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: 'Sign in to use the admin dashboard.', code: 'AUTH_REQUIRED' });
    }
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(401).json({ error: 'Sign in to use the admin dashboard.', code: 'AUTH_REQUIRED' });
    }

    if (user.role !== 'admin' && isBootstrapAdmin(user.email)) {
      user.role = 'admin';
      await user.save();
      audit({
        event: 'admin_granted',
        userId: user._id,
        email: user.email,
        req,
        metadata: { via: 'ADMIN_EMAILS' },
      });
    }

    if (user.role !== 'admin') {
      audit({
        event: 'admin_forbidden',
        userId: user._id,
        email: user.email,
        req,
        metadata: { path: req.originalUrl, method: req.method },
      });
      return res
        .status(403)
        .json({ error: 'Administrator access required.', code: 'ADMIN_REQUIRED' });
    }

    req.admin = user;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Promotes a user whose address is in ADMIN_EMAILS. Called on successful login
 * and email verification so `user.role` is already right when the client asks
 * whether to show the Admin link — without it, the promotion would only happen
 * on the first /api/admin request, which the UI never makes for a non-admin.
 */
export async function applyBootstrapAdmin(user, req) {
  if (!user || user.role === 'admin' || !isBootstrapAdmin(user.email)) return user;
  user.role = 'admin';
  await user.save();
  audit({
    event: 'admin_granted',
    userId: user._id,
    email: user.email,
    req,
    metadata: { via: 'ADMIN_EMAILS' },
  });
  return user;
}
