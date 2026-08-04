/** Formatting helpers shared by the admin panels. */

/** 2 -> "$2.00", 0.435 -> "$0.435", 0 -> "Free", null -> "—" (per 1M tokens). */
export function formatPrice(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  if (n === 0) return 'Free';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

/** "$2.00 / $8.00" for an in/out pair, or "—" when the model is unpriced. */
export function formatPricePair(price) {
  if (!price || (price.in == null && price.out == null)) return '—';
  return `${formatPrice(price.in)} / ${formatPrice(price.out)}`;
}

/** 128000 -> "128K", 1048576 -> "1.0M", null -> "—". */
export function formatContext(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/** Relative time, e.g. "3m ago". Falsy input -> "never". */
export function timeAgo(date) {
  if (!date) return 'never';
  const then = new Date(date).getTime();
  if (Number.isNaN(then)) return 'never';
  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(date).toLocaleDateString();
}

/** Absolute timestamp for tooltips. */
export function fullDate(date) {
  if (!date) return '—';
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

/**
 * Percentage change between two prices, as a signed string ("+25%", "−12%"),
 * or null when there's nothing meaningful to compare.
 */
export function priceDelta(current, next) {
  if (current == null || next == null) return null;
  if (Number(current) === Number(next)) return null;
  if (Number(current) === 0) return 'new';
  const pct = ((Number(next) - Number(current)) / Number(current)) * 100;
  const rounded = Math.abs(pct) < 1 ? pct.toFixed(1) : Math.round(pct);
  return `${pct > 0 ? '+' : '−'}${Math.abs(rounded)}%`;
}

/** A model/company id typed by a human -> the slug shape the API accepts. */
export function toSlug(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.\-_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** "admin_price_applied" -> "Price applied" for the activity feed. */
export function humanizeEvent(event) {
  const text = String(event || '').replace(/^admin_/, '').replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
