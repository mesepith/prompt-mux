/**
 * Where the admin dashboard lives.
 *
 * `/admin` is the first path any scanner tries, so the dashboard sits behind an
 * unguessable segment instead. This is defence in depth, NOT the access control —
 * `requireAdmin` is what actually protects the data, and it is unchanged. What the
 * secret segment buys is that a drive-by scan of a public host finds no admin
 * surface at all: a wrong segment 404s exactly like any other unknown path, so
 * there is nothing to probe, rate-limit, or fingerprint.
 *
 * Resolution order:
 *   1. `ADMIN_PATH` in server/.env — set this to something memorable you can type.
 *   2. A random segment generated on first boot and stored in AdminSetting, so an
 *      install that never configures anything still isn't sitting on a known URL.
 *      A default baked into this file would be public the moment the repo is.
 *
 * The value is cached in-process; `setCachedAdminPath` keeps it in step when an
 * admin changes it from the dashboard.
 */
import crypto from 'node:crypto';
import { AdminSetting, getAdminSettings } from '../models/AdminSetting.js';

// One path segment: letters, digits, dash, underscore. No slashes (that would
// change the route shape), no dots (they collide with static-asset handling).
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;

// Reserved because the client router and the API own these prefixes.
const RESERVED = new Set(['api', 'c', 'assets', 'logo.svg', 'index.html', 'favicon.ico']);

let cached = null;

export function normalizeAdminPath(value) {
  const trimmed = String(value || '')
    .trim()
    .replace(/^\/+|\/+$/g, '');
  if (!SEGMENT_RE.test(trimmed)) return null;
  if (RESERVED.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

export function generateAdminPath() {
  // Short enough to type, wide enough that guessing is hopeless (~10^14).
  return `mux-${crypto.randomBytes(6).toString('hex')}`;
}

/** The configured segment, or null before initAdminPath() has run. */
export function adminPathSegment() {
  return cached;
}

export function setCachedAdminPath(segment) {
  cached = segment;
}

/**
 * Called once at boot, after the DB connects. Returns the segment in force and
 * persists a generated one so it survives restarts.
 */
export async function initAdminPath() {
  const fromEnv = process.env.ADMIN_PATH;
  if (fromEnv && fromEnv.trim()) {
    const normalized = normalizeAdminPath(fromEnv);
    if (!normalized) {
      console.warn(
        `[admin] ADMIN_PATH="${fromEnv}" is not a usable path segment (letters, digits, - and _; 3-64 chars) — ignoring it.`
      );
    } else {
      cached = normalized;
      console.log(`[admin] dashboard at /${cached} (from ADMIN_PATH)`);
      return cached;
    }
  }

  const settings = await getAdminSettings();
  let stored = normalizeAdminPath(settings.adminPath);
  if (!stored) {
    stored = generateAdminPath();
    settings.adminPath = stored;
    await settings.save();
    console.log(
      `[admin] no ADMIN_PATH set — generated a private dashboard path: /${stored}\n` +
        '        It is shown on the dashboard\'s Settings tab and in GET /api/auth/me for admins.\n' +
        '        Set ADMIN_PATH in server/.env to choose your own.'
    );
  } else {
    console.log(`[admin] dashboard at /${stored}`);
  }
  cached = stored;
  return cached;
}

/**
 * Persists a new segment chosen from the dashboard. Refuses when ADMIN_PATH is
 * set, because the env var wins on the next boot and silently reverting an
 * admin's change would be worse than telling them.
 */
export async function updateAdminPath(value) {
  if (process.env.ADMIN_PATH && process.env.ADMIN_PATH.trim()) {
    const err = new Error(
      'The dashboard path is pinned by ADMIN_PATH in server/.env — change it there and restart.'
    );
    err.status = 409;
    throw err;
  }
  const normalized = normalizeAdminPath(value);
  if (!normalized) {
    const err = new Error(
      'Use 3-64 characters: letters, digits, dashes or underscores, and not a reserved word like "api".'
    );
    err.status = 400;
    throw err;
  }
  await AdminSetting.updateOne({ key: 'global' }, { $set: { adminPath: normalized } }, { upsert: true });
  cached = normalized;
  return normalized;
}
