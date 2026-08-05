/**
 * Turns stored message usage into per-user / per-chat / per-message cost rows.
 *
 * Two things make this less trivial than "sum the tokens":
 *
 *  1. **One message can bill two different models.** When the chat model can't see
 *     images, a separate vision model reads them (`Message.visionUsage`) and the
 *     reply model writes the answer (`Message.usage`). They have different prices,
 *     so a message's cost is the sum of two independently-priced calls. Anything
 *     that prices only `usage` understates every image conversation.
 *  2. **Reasoning tokens are already inside `outputTokens`.** Every provider we
 *     talk to reports them that way, so they are shown for information and must
 *     NOT be added to the bill again — doing so silently inflates the cost of
 *     exactly the models people use most.
 *
 * `priceOf` is injected rather than imported so this stays pure and testable: it
 * takes a modelId and returns `{ in, out }` per 1M tokens, or null when unknown.
 */

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** Rounds to a sane number of decimals for money without going full decimal type. */
export function round6(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * 1e6) / 1e6
    : null;
}

/**
 * Cost of one billed call. Returns costUsd null (not 0) when the model has no
 * price — "unknown" and "free" must not look the same in a bill.
 */
export function costOfCall(modelId, tokens, priceOf) {
  const price = modelId ? priceOf(modelId) : null;
  const inTok = num(tokens?.inputTokens);
  const outTok = num(tokens?.outputTokens);
  // Cache hits are a SUBSET of inputTokens (the adapters normalize every vendor's
  // shape to that), so they are split OUT of the full-price half rather than added.
  // Clamped: a provider reporting a hit bigger than the prompt must not produce a
  // negative bill.
  const cachedTok = Math.min(num(tokens?.cachedInputTokens), inTok);
  const fullTok = inTok - cachedTok;
  const hasPrice = price && typeof price.in === 'number' && typeof price.out === 'number';
  // No cachedIn rate means bill the hits at the full rate: overstating a bill is
  // safe, inventing a discount the vendor never gave is not.
  const cachedRate = price && typeof price.cachedIn === 'number' ? price.cachedIn : price?.in;
  return {
    modelId: modelId || null,
    inputTokens: inTok,
    outputTokens: outTok,
    // Reported, never re-billed: it is a subset of inputTokens.
    cachedInputTokens: cachedTok,
    // Reported, never re-billed: it is a subset of outputTokens.
    reasoningTokens: num(tokens?.reasoningTokens),
    totalTokens: num(tokens?.totalTokens) || inTok + outTok,
    costUsd: hasPrice
      ? round6((fullTok * price.in + cachedTok * cachedRate + outTok * price.out) / 1e6)
      : null,
    priced: Boolean(hasPrice),
  };
}

/**
 * Full breakdown for one message: the reply call, the optional vision call, and
 * the combined totals. `chat` is null for user messages (they carry no usage).
 */
export function messageBreakdown(message, priceOf) {
  const chat = message?.usage ? costOfCall(message.modelId, message.usage, priceOf) : null;
  const vision = message?.visionUsage?.modelId
    ? costOfCall(message.visionUsage.modelId, message.visionUsage, priceOf)
    : null;

  const parts = [chat, vision].filter(Boolean);
  // A null anywhere means at least one leg is unpriced, so the total is a floor
  // rather than the answer. Surfaced as `fullyPriced` so a UI can say so.
  const fullyPriced = parts.length > 0 && parts.every((p) => p.priced);
  const totalCostUsd = parts.some((p) => p.costUsd !== null)
    ? round6(parts.reduce((sum, p) => sum + (p.costUsd || 0), 0))
    : null;

  return {
    chat,
    vision,
    totalTokens: parts.reduce((sum, p) => sum + p.totalTokens, 0),
    inputTokens: parts.reduce((sum, p) => sum + p.inputTokens, 0),
    outputTokens: parts.reduce((sum, p) => sum + p.outputTokens, 0),
    reasoningTokens: parts.reduce((sum, p) => sum + p.reasoningTokens, 0),
    totalCostUsd,
    fullyPriced,
  };
}

/**
 * Prices a `[{ modelId, inputTokens, outputTokens, reasoningTokens, messages }]`
 * aggregation result (what Mongo gives us when grouping by model) into totals plus
 * a per-model breakdown. Used for the per-user and per-chat rollups, where pulling
 * every message into memory would not scale.
 */
export function rollUp(groups, priceOf) {
  const byModel = (Array.isArray(groups) ? groups : []).map((g) => {
    const call = costOfCall(g.modelId, g, priceOf);
    return { ...call, messages: num(g.messages), kind: g.kind || 'chat' };
  });

  const unpriced = byModel.filter((m) => !m.priced && m.totalTokens > 0);
  return {
    byModel: byModel.sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0) || b.totalTokens - a.totalTokens),
    messages: byModel.reduce((s, m) => s + (m.kind === 'chat' ? m.messages : 0), 0),
    inputTokens: byModel.reduce((s, m) => s + m.inputTokens, 0),
    // Subset of inputTokens. Surfaced so the dashboard can show how much of the
    // spend prompt caching is already absorbing — it is the difference between
    // "our bill is growing" and "our bill is growing but 60% of it is cached".
    cachedInputTokens: byModel.reduce((s, m) => s + m.cachedInputTokens, 0),
    outputTokens: byModel.reduce((s, m) => s + m.outputTokens, 0),
    reasoningTokens: byModel.reduce((s, m) => s + m.reasoningTokens, 0),
    totalTokens: byModel.reduce((s, m) => s + m.totalTokens, 0),
    costUsd: round6(byModel.reduce((s, m) => s + (m.costUsd || 0), 0)),
    // Never let an unpriced model quietly read as free.
    unpricedModels: [...new Set(unpriced.map((m) => m.modelId).filter(Boolean))],
    fullyPriced: unpriced.length === 0,
  };
}

/**
 * Stable identity for "who owns this". A signed-in user is `user:<id>`; an
 * anonymous browser session is `session:<id>`. Anonymous traffic still costs money,
 * so it has to appear in the report rather than being filtered out.
 */
export function ownerKey({ userId, sessionId }) {
  if (userId) return `user:${String(userId)}`;
  if (sessionId) return `session:${sessionId}`;
  // Chats created before per-user ownership existed carry neither field. There is
  // no one to attribute them to, and inventing an owner would be worse than saying
  // so — the report labels this bucket explicitly rather than calling it "unknown".
  return 'legacy';
}

/** Inverse of ownerKey, for turning a URL segment back into a Mongo filter. */
export function parseOwnerKey(key) {
  const raw = String(key || '');
  if (raw.startsWith('user:')) return { kind: 'user', userId: raw.slice(5) };
  if (raw.startsWith('session:')) return { kind: 'session', sessionId: raw.slice(8) };
  if (raw === 'legacy') return { kind: 'legacy' };
  return null;
}
