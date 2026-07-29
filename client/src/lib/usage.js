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
 * Estimated cost of one message. model.price = USD per 1M tokens { in, out }.
 * Returns null when the model has no price data.
 */
export function messageCost(usage, model) {
  if (!usage || !model?.price) return null;
  return (usage.inputTokens * model.price.in + usage.outputTokens * model.price.out) / 1e6;
}
