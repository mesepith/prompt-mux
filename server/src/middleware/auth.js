import { verifyToken, readAuthCookie } from '../lib/jwt.js';

/**
 * Reads the auth token cookie and the anonymous session header.
 * Sets req.userId when authenticated and req.sessionId when anonymous.
 * Never rejects; route handlers decide whether to require a user.
 */
export async function authMiddleware(req, res, next) {
  const token = readAuthCookie(req);
  if (token) {
    const payload = await verifyToken(token);
    if (payload) {
      req.userId = payload.userId;
      req.userEmail = payload.email;
    }
  }
  const sessionId = req.headers['x-session-id'];
  if (typeof sessionId === 'string' && sessionId.trim()) {
    req.sessionId = sessionId.trim();
  }
  next();
}

/**
 * Helper to build the owner filter for a Conversation query.
 */
export function ownerFilter(req) {
  if (req.userId) return { userId: req.userId };
  if (req.sessionId) return { sessionId: req.sessionId };
  return { _id: null }; // matches nothing
}

/**
 * True if req is allowed to see/modify a conversation doc.
 */
export function ownsConversation(req, conversation) {
  if (req.userId && String(conversation.userId) === String(req.userId)) return true;
  if (req.sessionId && conversation.sessionId === req.sessionId) return true;
  return false;
}
