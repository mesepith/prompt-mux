/**
 * The caller's IP address, normalized for storage.
 *
 * `req.ip` is only trustworthy because `index.js` sets `trust proxy` to
 * 'loopback' — nginx sits in front and forwards X-Forwarded-For. Without that
 * every value here would be 127.0.0.1. Never read X-Forwarded-For directly: a
 * client can send that header itself, and Express already picks the correct hop.
 *
 * Two shapes need flattening before anything compares or groups by them:
 *  - Node reports IPv4 clients on a dual-stack socket as `::ffff:1.2.3.4`, so the
 *    same visitor would otherwise appear as two different addresses.
 *  - Loopback arrives as `::1`, which is the same machine as `127.0.0.1`.
 *
 * Note this is personal data. It is stored so an admin can attribute usage and
 * spot abuse — the same reason `AuditLog` has recorded it since the auth work —
 * so it belongs in whatever retention policy covers that collection.
 */

const MAX_LENGTH = 45; // longest possible textual IPv6 address

export function normalizeIp(value) {
  if (typeof value !== 'string') return null;
  let ip = value.trim();
  if (!ip) return null;

  // A comma-separated list can appear if a proxy header leaks through; the first
  // entry is the originating client.
  if (ip.includes(',')) ip = ip.split(',')[0].trim();

  // IPv4-mapped IPv6 -> plain IPv4, so one visitor is one address.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1];

  if (ip === '::1') return '127.0.0.1';

  return ip.slice(0, MAX_LENGTH);
}

/** Convenience for route handlers. */
export function clientIp(req) {
  return normalizeIp(req?.ip) || normalizeIp(req?.socket?.remoteAddress) || null;
}
