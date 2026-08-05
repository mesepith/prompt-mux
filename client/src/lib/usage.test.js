/**
 * Unit tests for token/cost display maths.
 * Run: npm --prefix client test
 *
 * The property that matters: a cache hit must be billed at the cache rate and
 * must NOT be billed twice. Cached tokens arrive as a subset of inputTokens, so
 * anything that adds them instead of splitting them out doubles the prompt on
 * every long chat — and this is the number the user reads to decide what a chat
 * costs. Mirrors server/src/lib/usageReport.js#costOfCall, which prices the same
 * message for the admin report; the two must not drift.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { messageCost, splitInput, formatCost, formatTokens } from './usage.js';

// mistral-medium-3.5's real registry row, plus a model that publishes a cache rate.
const NO_CACHE_RATE = { price: { in: 1.5, out: 7.5, cachedIn: null } };
const WITH_CACHE_RATE = { price: { in: 3.0, out: 15.0, cachedIn: 0.3 } }; // kimi-k3

test('with no cache hit the cost is unchanged from plain input x rate', () => {
  const usage = { inputTokens: 6379, outputTokens: 5025 };
  const expected = (6379 * 1.5 + 5025 * 7.5) / 1e6;
  assert.equal(messageCost(usage, NO_CACHE_RATE), expected);
});

test('a cache hit is billed at the cache rate, not the full rate', () => {
  const usage = { inputTokens: 10_000, cachedInputTokens: 8_000, outputTokens: 1_000 };
  const expected = (2_000 * 3.0 + 8_000 * 0.3 + 1_000 * 15.0) / 1e6;
  assert.equal(messageCost(usage, WITH_CACHE_RATE), expected);
  // And it is genuinely cheaper than pretending there was no hit.
  const uncached = messageCost({ inputTokens: 10_000, outputTokens: 1_000 }, WITH_CACHE_RATE);
  assert.ok(messageCost(usage, WITH_CACHE_RATE) < uncached);
});

test('cached tokens are never billed twice', () => {
  const usage = { inputTokens: 10_000, cachedInputTokens: 8_000, outputTokens: 0 };
  const cost = messageCost(usage, WITH_CACHE_RATE);
  const asIfAdded = (10_000 * 3.0 + 8_000 * 0.3) / 1e6;
  assert.ok(cost < asIfAdded, 'the hit is split out of input, not added to it');
  // Exactly 10,000 input tokens are paid for, at two different rates.
  const { fullPrice, cachePrice } = splitInput(usage);
  assert.equal(fullPrice + cachePrice, 10_000);
});

test('a model with no published cache rate bills hits at the full rate', () => {
  // Overstating is safe; inventing a discount the vendor never gave is not.
  const usage = { inputTokens: 10_000, cachedInputTokens: 8_000, outputTokens: 0 };
  assert.equal(messageCost(usage, NO_CACHE_RATE), (10_000 * 1.5) / 1e6);
});

test('a hit bigger than the prompt cannot produce a negative bill', () => {
  const usage = { inputTokens: 100, cachedInputTokens: 999, outputTokens: 0 };
  assert.deepEqual(splitInput(usage), { fullPrice: 0, cachePrice: 100 });
  assert.ok(messageCost(usage, WITH_CACHE_RATE) >= 0);
});

test('a negative or missing hit is treated as no hit', () => {
  assert.deepEqual(splitInput({ inputTokens: 500, cachedInputTokens: -20 }), {
    fullPrice: 500,
    cachePrice: 0,
  });
  assert.deepEqual(splitInput({ inputTokens: 500 }), { fullPrice: 500, cachePrice: 0 });
  assert.deepEqual(splitInput(null), { fullPrice: 0, cachePrice: 0 });
});

test('an unpriced model still reports null rather than a wrong number', () => {
  assert.equal(messageCost({ inputTokens: 10, outputTokens: 10 }, {}), null);
  assert.equal(messageCost(null, WITH_CACHE_RATE), null);
});

test('the real saving on a fully-cached 6.4k prompt is visible in the formatting', () => {
  const cached = { inputTokens: 6379, cachedInputTokens: 6379, outputTokens: 200 };
  const fresh = { inputTokens: 6379, outputTokens: 200 };
  const saving = messageCost(fresh, WITH_CACHE_RATE) - messageCost(cached, WITH_CACHE_RATE);
  // 6,379 tokens at $3.00 vs $0.30 per million — the prompt gets ~10x cheaper.
  assert.equal(Number(saving.toFixed(6)), 0.017223);
  assert.equal(formatCost(saving), '$0.017'); // 3 decimals once past a cent
  assert.equal(formatTokens(6379), '6.4k');
});
