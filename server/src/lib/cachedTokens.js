/**
 * Reading cache-hit token counts back out of a provider's usage object.
 *
 * Prompt caching is what stops a long chat from paying full price to re-read its
 * own history every turn — measured on a real chat here, 53% of all input tokens
 * paid for were text already sent in an earlier turn.
 *
 * Every vendor reports the hit under a different name, and this app routes on
 * `company.adapter` precisely so a new OpenAI-compatible vendor needs no code
 * (AGENTS.md). So this sniffs the known shapes rather than switching on who the
 * company is:
 *
 *   OpenAI / Qwen / Mistral / GLM   usage.prompt_tokens_details.cached_tokens
 *   DeepSeek                        usage.prompt_cache_hit_tokens
 *   some gateways                   usage.cached_tokens
 *   Anthropic                       usage.cache_read_input_tokens (handled in its adapter)
 *   Google                          usageMetadata.cachedContentTokenCount (ditto)
 *
 * A vendor that reports nothing simply yields 0, which prices exactly as before —
 * so adding a field name here can only ever make a bill more accurate.
 */

const num = (value) => (typeof value === 'number' && value > 0 ? Math.round(value) : 0);

/** Cached (already-seen) prompt tokens in an OpenAI-compatible usage object. */
export function cachedFromOpenAIUsage(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  return (
    num(usage.prompt_tokens_details?.cached_tokens) ||
    num(usage.prompt_cache_hit_tokens) ||
    num(usage.cached_tokens) ||
    num(usage.promptTokensDetails?.cachedTokens) ||
    0
  );
}

/**
 * Splits input tokens into full-price and cache-price halves.
 *
 * Kept here so the client badge, the admin report and any future consumer agree.
 * `cachedInputTokens` is always a SUBSET of `inputTokens` — never an addition —
 * so a caller that ignores it still sees the true prompt size.
 */
export function billableInput(usage) {
  const input = num(usage?.inputTokens);
  const cached = Math.min(num(usage?.cachedInputTokens), input);
  return { fullPrice: input - cached, cachePrice: cached };
}
