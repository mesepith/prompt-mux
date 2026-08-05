/**
 * Unit tests for prompt-cache token accounting.
 * Run: npm --prefix server test
 *
 * The load-bearing rule: `cachedInputTokens` is always a SUBSET of `inputTokens`,
 * never an addition. Every vendor reports cache hits differently and two of them
 * (Anthropic especially) would invert that if taken at face value — and getting it
 * backwards means either double-billing the prompt or reporting a negative one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedFromOpenAIUsage, billableInput } from './cachedTokens.js';

test('OpenAI / Qwen / Mistral / GLM report hits under prompt_tokens_details', () => {
  assert.equal(
    cachedFromOpenAIUsage({ prompt_tokens: 6379, prompt_tokens_details: { cached_tokens: 5120 } }),
    5120
  );
});

test('DeepSeek reports hits under its own field name', () => {
  assert.equal(
    cachedFromOpenAIUsage({ prompt_tokens: 6379, prompt_cache_hit_tokens: 4000, prompt_cache_miss_tokens: 2379 }),
    4000
  );
});

test('a bare cached_tokens field and a camelCase gateway both work', () => {
  assert.equal(cachedFromOpenAIUsage({ cached_tokens: 900 }), 900);
  assert.equal(cachedFromOpenAIUsage({ promptTokensDetails: { cachedTokens: 700 } }), 700);
});

test('a vendor that reports nothing yields 0, so pricing is unchanged', () => {
  assert.equal(cachedFromOpenAIUsage({ prompt_tokens: 500, completion_tokens: 10 }), 0);
  assert.equal(cachedFromOpenAIUsage({}), 0);
  assert.equal(cachedFromOpenAIUsage(null), 0);
  assert.equal(cachedFromOpenAIUsage(undefined), 0);
  assert.equal(cachedFromOpenAIUsage('nonsense'), 0);
});

test('nonsense values never become negative or fractional token counts', () => {
  assert.equal(cachedFromOpenAIUsage({ prompt_tokens_details: { cached_tokens: -5 } }), 0);
  assert.equal(cachedFromOpenAIUsage({ prompt_tokens_details: { cached_tokens: 12.7 } }), 13);
  assert.equal(cachedFromOpenAIUsage({ prompt_tokens_details: { cached_tokens: null } }), 0);
});

test('input splits into full-price and cache-price halves that add back up', () => {
  const split = billableInput({ inputTokens: 6379, cachedInputTokens: 5120 });
  assert.deepEqual(split, { fullPrice: 1259, cachePrice: 5120 });
  assert.equal(split.fullPrice + split.cachePrice, 6379, 'the prompt size is preserved');
});

test('no cache hit means everything is full price', () => {
  assert.deepEqual(billableInput({ inputTokens: 500 }), { fullPrice: 500, cachePrice: 0 });
  assert.deepEqual(billableInput({ inputTokens: 500, cachedInputTokens: 0 }), {
    fullPrice: 500,
    cachePrice: 0,
  });
});

test('a hit larger than the prompt is clamped, never billed as negative', () => {
  // A provider bug, or an adapter that forgot cached tokens are a subset.
  const split = billableInput({ inputTokens: 100, cachedInputTokens: 999 });
  assert.deepEqual(split, { fullPrice: 0, cachePrice: 100 });
  assert.ok(split.fullPrice >= 0);
});

test('missing usage is handled rather than thrown on', () => {
  assert.deepEqual(billableInput(null), { fullPrice: 0, cachePrice: 0 });
  assert.deepEqual(billableInput({}), { fullPrice: 0, cachePrice: 0 });
});
