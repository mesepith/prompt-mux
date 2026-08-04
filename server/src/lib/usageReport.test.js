/**
 * Unit tests for the usage report maths.
 * Run: npm --prefix server test
 *
 * These numbers are shown to an admin as money, so the cases that matter are the
 * ones that would be wrong quietly: a message billed on two models where only
 * one leg is counted, an unpriced model rendered as free, reasoning tokens billed
 * again on top of the output tokens they are already part of, and a vision leg
 * making its message count twice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { round6, costOfCall, messageBreakdown, rollUp, ownerKey, parseOwnerKey } from './usageReport.js';

// $ per 1M tokens. 'free' is deliberately a real zero price — free and unknown
// must not behave alike. 'half' and 'stringly' are half-filled registry rows.
// Every other id is unknown to the registry.
const PRICES = {
  a: { in: 1, out: 2 },
  b: { in: 10, out: 30 },
  free: { in: 0, out: 0 },
  half: { in: 1 },
  stringly: { in: '1', out: '2' },
};
const priceOf = (modelId) => PRICES[modelId] || null;

const group = (over = {}) => ({
  modelId: 'a',
  messages: 1,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  kind: 'chat',
  ...over,
});

// --- round6 --------------------------------------------------------------

test('round6 keeps six decimals and refuses non-numbers', () => {
  assert.equal(round6(1 / 3), 0.333333);
  assert.equal(round6(0.0000004), 0);
  assert.equal(round6(0), 0);
  assert.equal(round6(2), 2);
  assert.equal(round6(null), null);
  assert.equal(round6(undefined), null);
  assert.equal(round6(NaN), null);
  assert.equal(round6(Infinity), null);
  assert.equal(round6('2'), null);
});

// --- costOfCall ----------------------------------------------------------

test('prices are per 1M tokens', () => {
  const call = costOfCall('a', { inputTokens: 1_000_000, outputTokens: 500_000 }, priceOf);
  assert.equal(call.costUsd, 2, '1M in at $1 plus 500k out at $2');
  assert.equal(call.priced, true);
  assert.equal(call.modelId, 'a');
  assert.equal(call.inputTokens, 1_000_000);
  assert.equal(call.outputTokens, 500_000);
  assert.equal(call.totalTokens, 1_500_000);
});

test('a single token is billed, not rounded away', () => {
  assert.equal(costOfCall('a', { inputTokens: 1, outputTokens: 0 }, priceOf).costUsd, 0.000001);
});

test('a free model costs exactly zero and is priced', () => {
  const call = costOfCall('free', { inputTokens: 635, outputTokens: 106 }, priceOf);
  assert.equal(call.costUsd, 0);
  assert.equal(call.priced, true, 'zero is a rate we know, not a rate we are missing');
  assert.equal(call.totalTokens, 741);
});

test('an unknown model costs null, never zero', () => {
  const call = costOfCall('mystery', { inputTokens: 1000, outputTokens: 1000 }, priceOf);
  assert.equal(call.costUsd, null, 'null means "we do not know"; 0 would read as free');
  assert.notEqual(call.costUsd, 0);
  assert.equal(call.priced, false);
  assert.equal(call.totalTokens, 2000, 'the tokens are still reported');
});

test('a missing modelId is not priceable', () => {
  for (const modelId of [null, undefined, '']) {
    const call = costOfCall(modelId, { inputTokens: 100, outputTokens: 100 }, priceOf);
    assert.equal(call.modelId, null, `modelId for ${JSON.stringify(modelId)}`);
    assert.equal(call.costUsd, null);
    assert.equal(call.priced, false);
  }
});

test('a half-filled registry price is not a price', () => {
  for (const modelId of ['half', 'stringly']) {
    const call = costOfCall(modelId, { inputTokens: 1_000_000, outputTokens: 1_000_000 }, priceOf);
    assert.equal(call.costUsd, null, `costUsd for ${modelId}`);
    assert.equal(call.priced, false, `priced for ${modelId}`);
  }
});

test('totalTokens falls back to in + out when the provider did not report one', () => {
  assert.equal(costOfCall('a', { inputTokens: 30, outputTokens: 12 }, priceOf).totalTokens, 42);
  assert.equal(costOfCall('a', { inputTokens: 30, outputTokens: 12, totalTokens: null }, priceOf).totalTokens, 42);
  assert.equal(
    costOfCall('a', { inputTokens: 30, outputTokens: 12, totalTokens: 44 }, priceOf).totalTokens,
    44,
    'a reported total is kept even when it disagrees with the parts'
  );
});

test('reasoning tokens are reported but never billed on top of output', () => {
  const tokens = { inputTokens: 1000, outputTokens: 2000, totalTokens: 3000 };
  const plain = costOfCall('a', tokens, priceOf);
  const thinking = costOfCall('a', { ...tokens, reasoningTokens: 1500 }, priceOf);
  assert.equal(plain.reasoningTokens, 0);
  assert.equal(thinking.reasoningTokens, 1500);
  assert.equal(thinking.costUsd, plain.costUsd, 'reasoning is a subset of output, already paid for');
  assert.equal(thinking.totalTokens, plain.totalTokens);
});

test('missing and non-numeric token counts read as 0, not NaN', () => {
  const shapes = [
    undefined,
    null,
    {},
    { inputTokens: NaN, outputTokens: undefined },
    { inputTokens: '500', outputTokens: Infinity, totalTokens: null },
    { inputTokens: false, outputTokens: {}, reasoningTokens: '7' },
  ];
  for (const tokens of shapes) {
    const call = costOfCall('a', tokens, priceOf);
    const label = JSON.stringify(tokens);
    assert.equal(call.inputTokens, 0, `inputTokens for ${label}`);
    assert.equal(call.outputTokens, 0, `outputTokens for ${label}`);
    assert.equal(call.reasoningTokens, 0, `reasoningTokens for ${label}`);
    assert.equal(call.totalTokens, 0, `totalTokens for ${label}`);
    assert.equal(call.costUsd, 0, `costUsd for ${label}`);
  }
});

// --- messageBreakdown ----------------------------------------------------

test('a user message has no legs and no cost', () => {
  for (const message of [{ role: 'user' }, { role: 'user', usage: null }, null, undefined]) {
    const out = messageBreakdown(message, priceOf);
    const label = JSON.stringify(message);
    assert.equal(out.chat, null, `chat for ${label}`);
    assert.equal(out.vision, null, `vision for ${label}`);
    assert.equal(out.totalCostUsd, null, `totalCostUsd for ${label}`);
    assert.equal(out.fullyPriced, false, 'nothing was billed, so nothing is fully priced');
    assert.equal(out.totalTokens, 0, `totalTokens for ${label}`);
    assert.equal(out.inputTokens, 0);
    assert.equal(out.outputTokens, 0);
  }
});

test('an assistant message with only a reply leg costs exactly that leg', () => {
  const out = messageBreakdown(
    {
      role: 'assistant',
      modelId: 'a',
      usage: { inputTokens: 3000, outputTokens: 1000, reasoningTokens: 400, totalTokens: 4000 },
    },
    priceOf
  );
  assert.equal(out.chat.modelId, 'a');
  assert.equal(out.vision, null);
  assert.equal(out.chat.costUsd, 0.005);
  assert.equal(out.totalCostUsd, 0.005);
  assert.equal(out.reasoningTokens, 400);
  assert.equal(out.totalTokens, 4000);
  assert.equal(out.fullyPriced, true);
});

test('a message billed on two models sums both legs', () => {
  const out = messageBreakdown(
    {
      role: 'assistant',
      modelId: 'a',
      usage: { inputTokens: 1_000_000, outputTokens: 500_000 }, // $2.00 on a
      visionUsage: { modelId: 'b', inputTokens: 100_000, outputTokens: 10_000 }, // $1.00 + $0.30 on b
    },
    priceOf
  );
  assert.equal(out.chat.modelId, 'a');
  assert.equal(out.vision.modelId, 'b');
  assert.equal(out.chat.costUsd, 2);
  assert.equal(out.vision.costUsd, 1.3);
  assert.equal(out.totalCostUsd, 3.3, 'pricing only the reply model understates every image conversation');
  assert.equal(out.inputTokens, 1_100_000);
  assert.equal(out.outputTokens, 510_000);
  assert.equal(out.totalTokens, 1_610_000);
  assert.equal(out.fullyPriced, true);
});

test('a free vision model adds tokens without adding cost', () => {
  // The live drilldown shape: an image chat whose vision leg ran on demo-vision.
  const out = messageBreakdown(
    {
      role: 'assistant',
      modelId: 'a',
      usage: { inputTokens: 100, outputTokens: 10 },
      visionUsage: { modelId: 'free', inputTokens: 635, outputTokens: 106 },
    },
    priceOf
  );
  assert.equal(out.vision.costUsd, 0);
  assert.equal(out.vision.priced, true);
  assert.equal(out.totalCostUsd, 0.00012, 'the chat leg alone');
  assert.equal(out.inputTokens, 735);
  assert.equal(out.fullyPriced, true);
});

test('an unpriced vision leg makes the total a floor, not unknown', () => {
  const out = messageBreakdown(
    {
      role: 'assistant',
      modelId: 'a',
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
      visionUsage: { modelId: 'mystery', inputTokens: 5000, outputTokens: 50 },
    },
    priceOf
  );
  assert.equal(out.chat.costUsd, 1);
  assert.equal(out.vision.costUsd, null);
  assert.equal(out.totalCostUsd, 1, 'the priced half is still real money spent');
  assert.equal(out.fullyPriced, false);
  assert.equal(out.inputTokens, 1_005_000, 'the unpriced tokens still count');
});

test('a message with both legs unpriced has no total at all', () => {
  const out = messageBreakdown(
    {
      role: 'assistant',
      modelId: 'mystery',
      usage: { inputTokens: 900, outputTokens: 300 },
      visionUsage: { modelId: 'other-mystery', inputTokens: 700, outputTokens: 20 },
    },
    priceOf
  );
  assert.equal(out.totalCostUsd, null);
  assert.equal(out.fullyPriced, false);
  assert.equal(out.totalTokens, 1920, 'unpriceable is not unmeasurable');
});

test('visionUsage without a modelId is how the schema says "no vision call"', () => {
  const out = messageBreakdown(
    {
      role: 'assistant',
      modelId: 'a',
      usage: { inputTokens: 100, outputTokens: 10 },
      visionUsage: { inputTokens: 0, outputTokens: 0 },
    },
    priceOf
  );
  assert.equal(out.vision, null);
  assert.equal(out.totalCostUsd, out.chat.costUsd);
  assert.equal(out.fullyPriced, true);
});

// --- rollUp --------------------------------------------------------------

test('rollUp prices each model separately and sums the tokens', () => {
  const out = rollUp(
    [
      group({ modelId: 'a', messages: 2, inputTokens: 1_000_000, outputTokens: 500_000, reasoningTokens: 6000 }),
      group({ modelId: 'b', messages: 1, inputTokens: 100_000, outputTokens: 10_000, reasoningTokens: 256 }),
    ],
    priceOf
  );
  assert.equal(out.costUsd, 3.3);
  assert.equal(out.messages, 3);
  assert.equal(out.inputTokens, 1_100_000);
  assert.equal(out.outputTokens, 510_000);
  assert.equal(out.reasoningTokens, 6256);
  assert.equal(out.totalTokens, 1_610_000);
  assert.deepEqual(
    out.byModel.map((m) => [m.modelId, m.costUsd]),
    [
      ['a', 2],
      ['b', 1.3],
    ]
  );
  assert.deepEqual(out.unpricedModels, []);
  assert.equal(out.fullyPriced, true);
});

test('the same model billed as chat and as vision counts its messages once', () => {
  // The live legacy bucket does exactly this: mistral-medium-3.5 appears twice,
  // 6 messages as the reply model and 9 as the vision model.
  const out = rollUp(
    [
      group({ modelId: 'a', kind: 'chat', messages: 5, inputTokens: 1000, outputTokens: 100 }),
      group({ modelId: 'a', kind: 'vision', messages: 3, inputTokens: 3000, outputTokens: 30 }),
    ],
    priceOf
  );
  assert.equal(out.messages, 5, 'a message with a vision leg must not be counted twice');
  assert.equal(out.byModel.length, 2, 'the two legs stay visible as separate rows');
  assert.deepEqual(
    out.byModel.map((m) => m.kind).sort(),
    ['chat', 'vision']
  );
  assert.equal(out.inputTokens, 4000, 'tokens, unlike messages, come from both legs');
  assert.equal(out.outputTokens, 130);
  assert.equal(out.costUsd, 0.00426);
});

test('a group with no kind is a chat group', () => {
  const out = rollUp([{ modelId: 'a', messages: 4, inputTokens: 10, outputTokens: 10 }], priceOf);
  assert.equal(out.byModel[0].kind, 'chat');
  assert.equal(out.messages, 4);
});

test('byModel is sorted most expensive first', () => {
  const out = rollUp(
    [
      group({ modelId: 'free', inputTokens: 900_000, outputTokens: 900_000 }),
      group({ modelId: 'a', inputTokens: 1000, outputTokens: 1000 }),
      group({ modelId: 'b', inputTokens: 1000, outputTokens: 1000 }),
    ],
    priceOf
  );
  assert.deepEqual(
    out.byModel.map((m) => [m.modelId, m.costUsd]),
    [
      ['b', 0.04],
      ['a', 0.003],
      ['free', 0],
    ]
  );
});

test('unpricedModels names the distinct models whose tokens we cannot price', () => {
  const out = rollUp(
    [
      group({ modelId: 'a', inputTokens: 1000, outputTokens: 1000 }),
      group({ modelId: 'mystery', kind: 'chat', inputTokens: 500, outputTokens: 200 }),
      group({ modelId: 'mystery', kind: 'vision', inputTokens: 100, outputTokens: 0 }),
      group({ modelId: 'other-mystery', inputTokens: 5, outputTokens: 5 }),
    ],
    priceOf
  );
  assert.deepEqual([...out.unpricedModels].sort(), ['mystery', 'other-mystery'], 'one entry per model, not per group');
  assert.equal(out.fullyPriced, false);
  assert.equal(out.costUsd, 0.003, 'the total is what we can price, and it is flagged as incomplete');
  assert.equal(out.totalTokens, 2810, 'the unpriced tokens are still counted');
});

test('an unpriced model with no tokens does not make the report unpriced', () => {
  const out = rollUp(
    [
      group({ modelId: 'a', inputTokens: 1000, outputTokens: 1000 }),
      group({ modelId: 'mystery', messages: 1, inputTokens: 0, outputTokens: 0 }),
    ],
    priceOf
  );
  assert.deepEqual(out.unpricedModels, []);
  assert.equal(out.fullyPriced, true, 'nothing was spent on it, so nothing is missing from the total');
  assert.equal(out.costUsd, 0.003);
});

test('nothing to roll up is a zeroed report, not a gap', () => {
  for (const groups of [[], null, undefined, 'not an array']) {
    const out = rollUp(groups, priceOf);
    const label = JSON.stringify(groups);
    assert.deepEqual(out.byModel, [], `byModel for ${label}`);
    assert.equal(out.messages, 0, `messages for ${label}`);
    assert.equal(out.inputTokens, 0);
    assert.equal(out.outputTokens, 0);
    assert.equal(out.reasoningTokens, 0);
    assert.equal(out.totalTokens, 0);
    assert.equal(out.costUsd, 0, 'no spend is a known zero, not an unknown');
    assert.deepEqual(out.unpricedModels, []);
    assert.equal(out.fullyPriced, true);
  }
});

// --- ownerKey / parseOwnerKey -------------------------------------------

test('a signed-in user owns the chat even when a session id is also present', () => {
  assert.equal(ownerKey({ userId: '665e', sessionId: '50c13588' }), 'user:665e');
  assert.equal(ownerKey({ userId: { toString: () => '665e' } }), 'user:665e', 'a Mongo ObjectId stringifies');
});

test('an anonymous session is a real owner', () => {
  assert.equal(ownerKey({ sessionId: '50c13588' }), 'session:50c13588');
  assert.equal(ownerKey({ userId: null, sessionId: '50c13588' }), 'session:50c13588');
});

test('a chat with neither owner falls into the legacy bucket', () => {
  for (const doc of [{}, { userId: null, sessionId: null }, { userId: '', sessionId: undefined }]) {
    assert.equal(ownerKey(doc), 'legacy', `ownerKey(${JSON.stringify(doc)})`);
  }
  // 96% of live spend sits in this bucket, so it has to be addressable as a URL segment.
  assert.deepEqual(parseOwnerKey('legacy'), { kind: 'legacy' });
});

test('parseOwnerKey inverts ownerKey', () => {
  assert.deepEqual(parseOwnerKey('user:abc'), { kind: 'user', userId: 'abc' });
  assert.deepEqual(parseOwnerKey(ownerKey({ userId: 'abc' })), { kind: 'user', userId: 'abc' });
  assert.deepEqual(parseOwnerKey(ownerKey({ sessionId: '50c13588' })), { kind: 'session', sessionId: '50c13588' });
});

test('a session id containing a colon survives the round trip', () => {
  const sessionId = 'abc:def:ghi';
  assert.deepEqual(parseOwnerKey(ownerKey({ sessionId })), { kind: 'session', sessionId });
});

test('parseOwnerKey rejects anything it did not write', () => {
  for (const junk of ['', null, undefined, 'legacy:1', 'admin', 'user', 'users:1', 'session', 42, {}]) {
    assert.equal(parseOwnerKey(junk), null, `parseOwnerKey(${JSON.stringify(junk)})`);
  }
});
