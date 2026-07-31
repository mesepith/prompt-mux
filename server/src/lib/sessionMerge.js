import { Conversation } from '../models/Conversation.js';
import { Message } from '../models/Message.js';

/**
 * After a user logs in or registers, reassign any anonymous chats created under
 * the given sessionId to the authenticated user.
 */
export async function mergeAnonymousSession({ sessionId, userId }) {
  if (!sessionId || !userId) return { conversations: 0, messages: 0 };
  const convResult = await Conversation.updateMany(
    { sessionId },
    { $set: { userId }, $unset: { sessionId: 1 } }
  );
  const msgResult = await Message.updateMany(
    { sessionId },
    { $set: { userId }, $unset: { sessionId: 1 } }
  );
  return { conversations: convResult.modifiedCount, messages: msgResult.modifiedCount };
}
