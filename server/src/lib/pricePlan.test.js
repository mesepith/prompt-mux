/**
 * Unit tests for the fetch planner.
 * Run: npm --prefix server test
 *
 * The plan is what the UI shows a human *before* it spends money: every entry in
 * `calls` is one paid model call. So the cases that matter are the ones where a
 * miscount costs real dollars — a company page mistaken for N per-model pages,
 * two models sharing a page billed twice — and silent truncation, which would
 * report success while leaving models unpriced.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFetchPlan, estimatePlanCost } from './pricePlan.js';

const KIMI_K3 = 'https://platform.kimi.ai/docs/pricing/chat-k3.md';
const KIMI_K27 = 'https://platform.kimi.ai/docs/pricing/chat-k27-code.md';
const KIMI_K26 = 'https://platform.kimi.ai/docs/pricing/chat-k26.md';

const moonshot = { id: 'moonshot', name: 'Moonshot AI', pricingUrl: null };
const deepseek = {
  id: 'deepseek',
  name: 'DeepSeek',
  pricingUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
};

// Real registry rows, trimmed to the fields the planner reads.
const KIMI_MODELS = [
  { id: 'kimi-k3', name: 'Kimi K3', pricingUrl: KIMI_K3 },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', pricingUrl: KIMI_K27 },
  { id: 'kimi-k2.7-code-highspeed', name: 'Kimi K2.7 Code HS', pricingUrl: KIMI_K27 },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', pricingUrl: KIMI_K26 },
];

const DEEPSEEK_MODELS = [
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
];

// $0.15 in / $0.60 out per 1M — Mistral Small 4's real rate, and the one the
// documented deepseek/moonshot estimates were measured against.
const ADMIN_MODEL = { id: 'mistral-small-4', name: 'Mistral Small 4', price: { in: 0.15, out: 0.6 } };

// --- buildFetchPlan: company mode ---------------------------------------

test('a company pricing page is one call covering every active model', () => {
  const plan = buildFetchPlan(deepseek, DEEPSEEK_MODELS);
  assert.equal(plan.mode, 'company');
  assert.equal(plan.calls.length, 1);
  assert.equal(plan.calls[0].url, deepseek.pricingUrl);
  assert.deepEqual(plan.calls[0].modelSlugs, ['deepseek-v4-pro', 'deepseek-v4-flash']);
  assert.deepEqual(plan.calls[0].modelNames, ['DeepSeek V4 Pro', 'DeepSeek V4 Flash']);
  assert.deepEqual(plan.uncovered, []);
  assert.equal(plan.dropped, 0);
});

test('the company page wins over per-model URLs — one call must beat several', () => {
  const withCompanyPage = { ...moonshot, pricingUrl: 'https://platform.kimi.ai/docs/pricing.md' };
  const plan = buildFetchPlan(withCompanyPage, KIMI_MODELS);
  assert.equal(plan.mode, 'company');
  assert.equal(plan.calls.length, 1, 'four models on three pages, but one company page prices them all');
  assert.equal(plan.calls[0].url, 'https://platform.kimi.ai/docs/pricing.md');
  assert.deepEqual(plan.calls[0].modelSlugs, KIMI_MODELS.map((m) => m.id));
  assert.deepEqual(plan.uncovered, [], 'the company page covers models that have no URL of their own');
});

test('a whitespace-only company URL is not a page', () => {
  const plan = buildFetchPlan({ ...deepseek, pricingUrl: '   ' }, KIMI_MODELS);
  assert.equal(plan.mode, 'per-model');
  assert.equal(plan.calls.length, 3);
});

// --- buildFetchPlan: per-model mode -------------------------------------

test('no company page means one call per distinct model page', () => {
  const models = [
    { id: 'qwen3-max', name: 'Qwen3 Max', pricingUrl: 'https://example.com/qwen3-max' },
    { id: 'qwen3-plus', name: 'Qwen3 Plus', pricingUrl: 'https://example.com/qwen3-plus' },
  ];
  const plan = buildFetchPlan(moonshot, models);
  assert.equal(plan.mode, 'per-model');
  assert.deepEqual(
    plan.calls.map((c) => [c.url, c.modelSlugs]),
    [
      ['https://example.com/qwen3-max', ['qwen3-max']],
      ['https://example.com/qwen3-plus', ['qwen3-plus']],
    ]
  );
  assert.equal(plan.dropped, 0);
});

test('two models sharing a page cost one call, not two', () => {
  const plan = buildFetchPlan(moonshot, KIMI_MODELS);
  assert.equal(plan.mode, 'per-model');
  assert.equal(plan.calls.length, 3, 'four models, three pages');
  assert.deepEqual(
    plan.calls.map((c) => ({ url: c.url, slugs: c.modelSlugs, names: c.modelNames })),
    [
      { url: KIMI_K3, slugs: ['kimi-k3'], names: ['Kimi K3'] },
      {
        url: KIMI_K27,
        slugs: ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed'],
        names: ['Kimi K2.7 Code', 'Kimi K2.7 Code HS'],
      },
      { url: KIMI_K26, slugs: ['kimi-k2.6'], names: ['Kimi K2.6'] },
    ]
  );
});

test('a shared page lists its models in registry order', () => {
  const reversed = [KIMI_MODELS[2], KIMI_MODELS[1]];
  const plan = buildFetchPlan(moonshot, reversed);
  assert.equal(plan.calls.length, 1);
  assert.deepEqual(plan.calls[0].modelSlugs, ['kimi-k2.7-code-highspeed', 'kimi-k2.7-code']);
});

test('models sharing a page still share it when one of the URLs is padded', () => {
  const padded = [
    { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', pricingUrl: `  ${KIMI_K27}  ` },
    { id: 'kimi-k2.7-code-highspeed', name: 'Kimi K2.7 Code HS', pricingUrl: KIMI_K27 },
  ];
  const plan = buildFetchPlan(moonshot, padded);
  assert.equal(plan.calls.length, 1, 'the trimmed URLs are the same page');
  assert.equal(plan.calls[0].url, KIMI_K27);
});

// --- buildFetchPlan: active flag ----------------------------------------

test('inactive models are left out by default and priced on request', () => {
  const models = [
    { id: 'kimi-k3', name: 'Kimi K3', pricingUrl: KIMI_K3 },
    { id: 'kimi-k2.6', name: 'Kimi K2.6', pricingUrl: KIMI_K26, active: false },
  ];
  const off = buildFetchPlan(moonshot, models);
  assert.deepEqual(
    off.calls.map((c) => c.url),
    [KIMI_K3]
  );
  const on = buildFetchPlan(moonshot, models, { includeInactive: true });
  assert.deepEqual(
    on.calls.map((c) => c.url),
    [KIMI_K3, KIMI_K26]
  );
});

test('the company plan lists only active models unless asked otherwise', () => {
  const models = [
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', active: false },
  ];
  assert.deepEqual(buildFetchPlan(deepseek, models).calls[0].modelSlugs, ['deepseek-v4-pro']);
  assert.deepEqual(buildFetchPlan(deepseek, models, { includeInactive: true }).calls[0].modelSlugs, [
    'deepseek-v4-pro',
    'deepseek-v4-flash',
  ]);
});

test('active: true and a missing active flag both count as active', () => {
  const models = [
    { id: 'a', name: 'A', pricingUrl: 'https://example.com/a', active: true },
    { id: 'b', name: 'B', pricingUrl: 'https://example.com/b' },
  ];
  assert.equal(buildFetchPlan(moonshot, models).calls.length, 2);
});

// --- buildFetchPlan: uncovered and 'none' -------------------------------

test('a model with no page of its own is reported, not fetched', () => {
  const models = [
    { id: 'kimi-k3', name: 'Kimi K3', pricingUrl: KIMI_K3 },
    { id: 'demo-artist', name: 'Demo Artist' },
    { id: 'demo-vision', name: 'Demo Vision', pricingUrl: '   ' },
  ];
  const plan = buildFetchPlan(moonshot, models);
  assert.equal(plan.mode, 'per-model');
  assert.equal(plan.calls.length, 1, 'the models with no URL add no calls');
  assert.deepEqual(plan.uncovered, [
    { slug: 'demo-artist', name: 'Demo Artist' },
    { slug: 'demo-vision', name: 'Demo Vision' },
  ]);
});

test('no URL anywhere is mode none with everything uncovered', () => {
  const models = [
    { id: 'demo-artist', name: 'Demo Artist' },
    { id: 'demo-vision', name: 'Demo Vision', pricingUrl: null },
  ];
  const plan = buildFetchPlan({ id: 'demo', name: 'Demo', pricingUrl: null }, models);
  assert.equal(plan.mode, 'none');
  assert.deepEqual(plan.calls, []);
  assert.deepEqual(plan.uncovered, [
    { slug: 'demo-artist', name: 'Demo Artist' },
    { slug: 'demo-vision', name: 'Demo Vision' },
  ]);
  assert.equal(plan.dropped, 0);
});

// --- buildFetchPlan: maxCalls ------------------------------------------

test('maxCalls truncates the plan and reports exactly what was left out', () => {
  const plan = buildFetchPlan(moonshot, KIMI_MODELS, { maxCalls: 2 });
  assert.equal(plan.calls.length, 2);
  assert.deepEqual(
    plan.calls.map((c) => c.url),
    [KIMI_K3, KIMI_K27]
  );
  assert.equal(plan.dropped, 1, 'dropped counts the pages NOT in calls — truncating silently is the bug');
  assert.equal(plan.calls.length + plan.dropped, 3, 'every page is either planned or counted as dropped');
});

test('a maxCalls above the page count drops nothing', () => {
  for (const maxCalls of [3, 12, 99]) {
    const plan = buildFetchPlan(moonshot, KIMI_MODELS, { maxCalls });
    assert.equal(plan.calls.length, 3, `calls at maxCalls ${maxCalls}`);
    assert.equal(plan.dropped, 0, `dropped at maxCalls ${maxCalls}`);
  }
});

test('maxCalls does not cap a company plan — it is one call by construction', () => {
  const plan = buildFetchPlan(deepseek, DEEPSEEK_MODELS, { maxCalls: 1 });
  assert.equal(plan.calls.length, 1);
  assert.equal(plan.dropped, 0);
});

// --- buildFetchPlan: defensive input ----------------------------------

test('a missing models list is a plan, not a crash', () => {
  for (const models of [null, undefined, [], 'not an array']) {
    const plan = buildFetchPlan(moonshot, models);
    assert.equal(plan.mode, 'none', `mode for ${JSON.stringify(models)}`);
    assert.deepEqual(plan.calls, []);
    assert.deepEqual(plan.uncovered, []);
  }
});

test('a company page with no models is still one call, with nothing to match', () => {
  const plan = buildFetchPlan(deepseek, null);
  assert.equal(plan.mode, 'company');
  assert.equal(plan.calls.length, 1);
  assert.deepEqual(plan.calls[0].modelSlugs, []);
  assert.deepEqual(plan.calls[0].modelNames, []);
});

test('a null entry in the models list is skipped without taking the rest with it', () => {
  const models = [null, { id: 'kimi-k3', name: 'Kimi K3', pricingUrl: KIMI_K3 }, undefined];
  const plan = buildFetchPlan(moonshot, models);
  assert.equal(plan.calls.length, 1);
  assert.deepEqual(plan.calls[0].modelSlugs, ['kimi-k3']);
  assert.deepEqual(plan.uncovered, [], 'a null row is not an uncovered model');
});

test('a missing company object falls back to the per-model route', () => {
  for (const company of [null, undefined, {}]) {
    const plan = buildFetchPlan(company, KIMI_MODELS);
    assert.equal(plan.mode, 'per-model', `mode for ${JSON.stringify(company)}`);
    assert.equal(plan.calls.length, 3);
  }
});

// --- estimatePlanCost --------------------------------------------------

test('a priced admin model gives a positive range that widens the right way', () => {
  const plan = buildFetchPlan(deepseek, DEEPSEEK_MODELS);
  const est = estimatePlanCost(plan, ADMIN_MODEL);
  assert.equal(est.calls, 1);
  assert.ok(est.lowUsd > 0, 'a paid call is never free');
  assert.ok(est.highUsd > est.lowUsd);
  // The documented deepseek estimate: one call, $0.0003-$0.0014 at this rate.
  assert.equal(est.lowUsd.toFixed(4), '0.0003');
  assert.equal(est.highUsd.toFixed(4), '0.0014');
});

test('cost scales linearly with the number of calls — three pages cost three times one', () => {
  const one = estimatePlanCost(buildFetchPlan(moonshot, [KIMI_MODELS[0]]), ADMIN_MODEL);
  const two = estimatePlanCost(buildFetchPlan(moonshot, [KIMI_MODELS[0], KIMI_MODELS[3]]), ADMIN_MODEL);
  const three = estimatePlanCost(buildFetchPlan(moonshot, KIMI_MODELS), ADMIN_MODEL);
  assert.deepEqual([one.calls, two.calls, three.calls], [1, 2, 3]);
  assert.equal(two.lowUsd, one.lowUsd * 2);
  assert.equal(two.highUsd, one.highUsd * 2);
  assert.equal(three.lowUsd, one.lowUsd * 3);
  // The documented moonshot estimate: three calls, $0.0010-$0.0041.
  assert.equal(three.lowUsd.toFixed(4), '0.0010');
  assert.equal(three.highUsd.toFixed(4), '0.0041');
});

test('an unpriced admin model still reports the call count, with no figures', () => {
  const plan = buildFetchPlan(moonshot, KIMI_MODELS);
  const unpriceable = [
    null,
    undefined,
    { id: 'no-price', name: 'No Price' },
    { id: 'null-price', name: 'Null Price', price: null },
    { id: 'half-price', name: 'In Only', price: { in: 0.15 } },
    { id: 'string-price', name: 'String Price', price: { in: '0.15', out: '0.6' } },
  ];
  for (const adminModel of unpriceable) {
    const est = estimatePlanCost(plan, adminModel);
    assert.equal(est.calls, 3, `calls for ${adminModel?.id ?? adminModel}`);
    assert.equal(est.lowUsd, null, `lowUsd for ${adminModel?.id ?? adminModel}`);
    assert.equal(est.highUsd, null, `highUsd for ${adminModel?.id ?? adminModel}`);
  }
});

test('a free admin model is a real rate, not a missing one', () => {
  const plan = buildFetchPlan(deepseek, DEEPSEEK_MODELS);
  const est = estimatePlanCost(plan, { id: 'free', name: 'Free', price: { in: 0, out: 0 } });
  assert.equal(est.lowUsd, 0);
  assert.equal(est.highUsd, 0);
});

test('an empty plan costs nothing and reports zero calls', () => {
  const empty = buildFetchPlan({ id: 'demo', name: 'Demo' }, [{ id: 'demo-artist', name: 'Demo Artist' }]);
  for (const plan of [empty, null, undefined, {}, { calls: [] }]) {
    const est = estimatePlanCost(plan, ADMIN_MODEL);
    assert.equal(est.calls, 0);
    assert.equal(est.lowUsd, null);
    assert.equal(est.highUsd, null);
  }
});
