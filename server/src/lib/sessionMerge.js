import { Conversation } from '../models/Conversation.js';
import { Message } from '../models/Message.js';
import { Artifact } from '../models/Artifact.js';

/**
 * After a user logs in or registers, reassign any anonymous chats created under
 * the given sessionId to the authenticated user.
 *
 * Published artifacts move too: their owner fields are what the `/a/<id>` page
 * checks before showing a private link, so leaving them on the old sessionId
 * would lock the user out of pages they had just made.
 */
export async function mergeAnonymousSession({ sessionId, userId }) {
  if (!sessionId || !userId) return { conversations: 0, messages: 0, artifacts: 0 };
  const convResult = await Conversation.updateMany(
    { sessionId },
    { $set: { userId }, $unset: { sessionId: 1 } }
  );
  const msgResult = await Message.updateMany(
    { sessionId },
    { $set: { userId }, $unset: { sessionId: 1 } }
  );
  const artifactResult = await Artifact.updateMany(
    { sessionId },
    { $set: { userId }, $unset: { sessionId: 1 } }
  );
  return {
    conversations: convResult.modifiedCount,
    messages: msgResult.modifiedCount,
    artifacts: artifactResult.modifiedCount,
  };
}
