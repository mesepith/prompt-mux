/**
 * Symmetric encryption for provider API keys stored in MongoDB.
 *
 * Keys entered in the admin dashboard are written to the `providers` collection,
 * so they must not sit there in plaintext: a Mongo dump, a backup or a stray
 * `db.providers.find()` would otherwise hand over every paid credential the
 * instance owns. AES-256-GCM gives us confidentiality plus tamper detection.
 *
 * The encryption key comes from `ENCRYPTION_KEY` (32 bytes, hex or base64).
 * When that is unset we derive one from `JWT_SECRET` so existing installs keep
 * working without an .env edit — with the obvious caveat that rotating
 * JWT_SECRET then makes stored provider keys unreadable. `decryptSecret`
 * returns null instead of throwing in that case, so the app degrades to
 * "no key stored" rather than failing every request.
 */
import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const KDF_SALT = 'promptmux-provider-keys-v1';

let cachedKey = null;
let cachedFrom = null;
let derivationWarned = false;

function parseExplicitKey(raw) {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.length === 32) return decoded;
  throw new Error(
    'ENCRYPTION_KEY must be 32 bytes — 64 hex characters or base64. Generate one with: openssl rand -hex 32'
  );
}

/**
 * The 32-byte AES key. Cached, because scrypt derivation is deliberately slow.
 * Throws when neither ENCRYPTION_KEY nor a usable JWT_SECRET is configured.
 */
export function encryptionKey() {
  if (cachedKey) return cachedKey;

  const explicit = process.env.ENCRYPTION_KEY;
  if (explicit && explicit.trim()) {
    cachedKey = parseExplicitKey(explicit);
    cachedFrom = 'ENCRYPTION_KEY';
    return cachedKey;
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.trim().length < 16) {
    throw new Error(
      'Cannot encrypt provider keys: set ENCRYPTION_KEY (32 bytes) in server/.env, or a JWT_SECRET of at least 16 characters.'
    );
  }
  if (!derivationWarned) {
    derivationWarned = true;
    console.warn(
      '[secrets] ENCRYPTION_KEY is not set — deriving the provider-key encryption key from JWT_SECRET. ' +
        'Changing JWT_SECRET will make stored provider keys unreadable (env-var keys keep working).'
    );
  }
  cachedKey = crypto.scryptSync(jwtSecret.trim(), KDF_SALT, 32);
  cachedFrom = 'JWT_SECRET';
  return cachedKey;
}

/** Where the encryption key came from — surfaced in the dashboard's health panel. */
export function encryptionKeySource() {
  try {
    encryptionKey();
    return cachedFrom;
  } catch {
    return null;
  }
}

/** True when secrets can be stored at all. */
export function encryptionAvailable() {
  try {
    encryptionKey();
    return true;
  } catch {
    return false;
  }
}

/** Test seam: forget the cached key (used after mutating env in tests). */
export function resetEncryptionKeyCache() {
  cachedKey = null;
  cachedFrom = null;
  derivationWarned = false;
}

/**
 * Encrypts a secret into a self-describing string:
 *   v1:<iv-b64>:<authTag-b64>:<ciphertext-b64>
 */
export function encryptSecret(plaintext) {
  if (typeof plaintext !== 'string' || !plaintext.length) {
    throw new Error('encryptSecret expects a non-empty string');
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(
    ':'
  );
}

/**
 * Decrypts a value produced by encryptSecret. Returns null (and logs once per
 * call) when the blob is malformed or the current key can't open it — a rotated
 * ENCRYPTION_KEY must not take the whole app down.
 */
export function decryptSecret(blob) {
  if (typeof blob !== 'string' || !blob.length) return null;
  const parts = blob.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    console.warn('[secrets] stored secret is not in the expected v1 format — ignoring it');
    return null;
  }
  try {
    const [, ivB64, tagB64, dataB64] = parts;
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      encryptionKey(),
      Buffer.from(ivB64, 'base64')
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]);
    return plain.toString('utf8');
  } catch (err) {
    console.warn(
      `[secrets] could not decrypt a stored provider key (${err.message}). ` +
        'If ENCRYPTION_KEY or JWT_SECRET changed, re-enter the key in the admin dashboard.'
    );
    return null;
  }
}

/** Last 4 characters of a key — the only part ever shown back to an admin. */
export function keyLast4(plaintext) {
  const s = String(plaintext || '');
  return s.length <= 4 ? s : s.slice(-4);
}

/** "sk-…a1b2" — a human-checkable hint that never reveals a usable credential. */
export function maskKey(plaintext) {
  const s = String(plaintext || '');
  if (!s) return null;
  if (s.length <= 8) return `${'•'.repeat(Math.max(0, s.length - 2))}${s.slice(-2)}`;
  return `${s.slice(0, 3)}…${'•'.repeat(4)}${s.slice(-4)}`;
}
