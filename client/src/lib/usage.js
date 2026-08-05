/** Token/cost formatting helpers for the usage badges. */

/** 1234 -> "1,234" (full, for the breakdown card) */
export function formatTokensFull(n) {
  return n == null ? '—' : n.toLocaleString('en-US');
}

/** 1234 -> "1.2k", 45200 -> "45k", 1200000 -> "1.2M" (compact, for pills) */
export function formatTokens(n) {
  if (n == null) return '—';
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
}

/** Cost in USD -> "$0.0034" style string. Returns null when unknown. */
export function formatCost(usd) {
  if (usd == null) return null;
  if (usd === 0) return '$0';
  if (usd < 0.0001) return '<$0.0001';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Splits input tokens into full-price and cache-price halves.
 *
 * `cachedInputTokens` is a SUBSET of `inputTokens` (the adapters normalize every
 * vendor's shape to that), so the two parts always add back up to the real prompt
 * size. Clamped because a provider that reports a hit larger than the prompt would
 * otherwise produce a negative bill.
 */
export function splitInput(usage) {
  const input = usage?.inputTokens || 0;
  const cached = Math.min(Math.max(usage?.cachedInputTokens || 0, 0), input);
  return { fullPrice: input - cached, cachePrice: cached };
}

/**
 * Estimated cost of one message. model.price = USD per 1M tokens
 * { in, out, cachedIn }. Returns null when the model has no price data.
 *
 * Cache hits are billed at `cachedIn` when the model has that rate — without it,
 * a long chat is quoted at full price for history the vendor already cached and
 * charged a tenth for. When `cachedIn` is unknown, cached tokens fall back to the
 * full rate: overstating is safer than inventing a discount.
 */
export function messageCost(usage, model) {
  if (!usage || !model?.price) return null;
  const { fullPrice, cachePrice } = splitInput(usage);
  const cachedRate =
    typeof model.price.cachedIn === 'number' ? model.price.cachedIn : model.price.in;
  return (
    (fullPrice * model.price.in + cachePrice * cachedRate + usage.outputTokens * model.price.out) /
    1e6
  );
}
