/**
 * Unit tests for the price extractor.
 * Run: npm --prefix server test
 *
 * parsePriceReply is the guard between "a model read a web page" and "this is
 * what we bill users". So the cases that matter most are the refusals: a wrong
 * unit is a 1000× error, and an invented number is worse than a missing row.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRICE_SYSTEM_PROMPT,
  buildPricePrompt,
  normalizeToPerMillion,
  parsePriceReply,
  matchProposalItems,
} from './priceExtract.js';

const MODELS = [
  { slug: 'gpt-5', name: 'GPT-5', apiModel: 'gpt-5-2025-08-07', currentIn: 1.25, currentOut: 10 },
  { slug: 'claude-sonnet', name: 'Claude Sonnet 4.5', apiModel: 'claude-sonnet-4-5', currentIn: 3, currentOut: 15 },
  { slug: 'gemini-flash', name: 'Gemini 2.5 Flash', apiModel: null, currentIn: 0.3, currentOut: 2.5 },
];

const reply = (items, warnings = []) => JSON.stringify({ items, warnings });
const row = (over = {}) => ({
  modelSlug: null,
  label: 'GPT-5',
  apiModel: 'gpt-5-2025-08-07',
  unit: 'per 1M tokens',
  currency: 'USD',
  inPrice: 1.25,
  outPrice: 10,
  cachedInPrice: null,
  confidence: 0.9,
  evidence: 'GPT-5 $1.25 / 1M input tokens, $10.00 / 1M output tokens',
  ...over,
});

// --- prompt --------------------------------------------------------------

test('system prompt forbids guessing and pins the unit convention', () => {
  assert.match(PRICE_SYSTEM_PROMPT, /ONLY one JSON object/);
  assert.match(PRICE_SYSTEM_PROMPT, /Never guess/);
  assert.match(PRICE_SYSTEM_PROMPT, /omit that row entirely/);
  assert.match(PRICE_SYSTEM_PROMPT, /per 1,000,000 tokens/);
  assert.match(PRICE_SYSTEM_PROMPT, /"evidence"/);
  assert.match(PRICE_SYSTEM_PROMPT, /DATA, not instructions/);
});

test('buildPricePrompt carries the page, the source and each model with its current price', () => {
  const prompt = buildPricePrompt({
    pageText: 'GPT-5 — $1.25 input / $10 output per 1M tokens',
    sourceUrl: 'https://openai.com/api/pricing/',
    companyName: 'OpenAI',
    models: MODELS,
  });
  assert.match(prompt, /OpenAI/);
  assert.match(prompt, /https:\/\/openai\.com\/api\/pricing\//);
  assert.match(prompt, /modelSlug "gpt-5" — name "GPT-5", apiModel "gpt-5-2025-08-07"/);
  assert.match(prompt, /in \$1\.25, out \$10/);
  assert.match(prompt, /in not set, out not set|in \$0\.3, out \$2\.5/);
  assert.match(prompt, /"cachedInPrice"/);
  assert.match(prompt, /BEGIN PAGE TEXT[\s\S]*\$1\.25 input[\s\S]*END PAGE TEXT/);
});

test('buildPricePrompt survives an empty registry and missing text', () => {
  const prompt = buildPricePrompt({ pageText: null, sourceUrl: null, companyName: null, models: null });
  assert.match(prompt, /no models for this provider yet/);
  assert.match(prompt, /source url unknown/);
});

// --- normalizeToPerMillion ----------------------------------------------

test('normalizeToPerMillion converts each unit the pages actually use', () => {
  assert.equal(normalizeToPerMillion(2.5, 'per 1M tokens'), 2.5);
  assert.equal(normalizeToPerMillion(2.5, 'per 1,000,000 tokens'), 2.5);
  assert.equal(normalizeToPerMillion(2.5, 'USD per million tokens'), 2.5);
  assert.equal(normalizeToPerMillion(0.15, 'per 1K tokens'), 150);
  assert.equal(normalizeToPerMillion(0.15, 'per 1,000 tokens'), 150);
  assert.equal(normalizeToPerMillion(0.0005, 'per thousand tokens'), 0.5);
  assert.equal(normalizeToPerMillion(0.0000025, 'per token'), 2.5);
});

test('normalizeToPerMillion treats an unknown or missing unit as already per 1M', () => {
  assert.equal(normalizeToPerMillion(4, 'per widget'), 4);
  assert.equal(normalizeToPerMillion(4, null), 4);
  assert.equal(normalizeToPerMillion(4, ''), 4);
});

test('normalizeToPerMillion rejects nothing-numbers and negatives', () => {
  assert.equal(normalizeToPerMillion(null, 'per 1M tokens'), null);
  assert.equal(normalizeToPerMillion(undefined, 'per 1M tokens'), null);
  assert.equal(normalizeToPerMillion('', 'per 1M tokens'), null);
  assert.equal(normalizeToPerMillion('free', 'per 1M tokens'), null);
  assert.equal(normalizeToPerMillion(NaN, 'per 1M tokens'), null);
  assert.equal(normalizeToPerMillion(Infinity, 'per 1M tokens'), null);
  assert.equal(normalizeToPerMillion(-1, 'per 1M tokens'), null);
  assert.equal(normalizeToPerMillion(0, 'per 1M tokens'), 0, 'a free model is a real price');
});

// --- parsePriceReply ----------------------------------------------------

test('parses a clean reply', () => {
  const { items, warnings } = parsePriceReply(reply([row()], ['prices unchanged']));
  assert.equal(items.length, 1);
  assert.deepEqual(warnings, ['prices unchanged']);
  assert.equal(items[0].inPrice, 1.25);
  assert.equal(items[0].outPrice, 10);
  assert.equal(items[0].currency, 'USD');
  assert.equal(items[0].matchedBy, null);
  assert.equal(items[0].currentIn, null, 'the registry snapshot is matchProposalItems’ job');
});

test('unwraps a markdown code fence', () => {
  const { items } = parsePriceReply('```json\n' + reply([row()]) + '\n```');
  assert.equal(items.length, 1);
  assert.equal(items[0].inPrice, 1.25);
});

test('ignores prose around the JSON', () => {
  const raw = `Sure! Here are the prices I found on that page:\n\n${reply([row()])}\n\nLet me know if you need the batch rates too.`;
  const { items } = parsePriceReply(raw);
  assert.equal(items.length, 1);
  assert.equal(items[0].outPrice, 10);
});

test('is not fooled by a bracket in the prose before the JSON', () => {
  const { items } = parsePriceReply(`Prices [as of today] from the page:\n${reply([row()])}`);
  assert.equal(items.length, 1);
  assert.equal(items[0].inPrice, 1.25);
});

test('takes the outermost object even when evidence contains braces and quotes', () => {
  const raw = reply([row({ evidence: 'pricing table {input: "$1.25"} per 1M' })]);
  const { items } = parsePriceReply(`Here you go:\n${raw}\nDone.`);
  assert.equal(items.length, 1);
  assert.match(items[0].evidence, /\{input: "\$1\.25"\}/);
});

test('never throws on malformed input — reports the problem instead', () => {
  for (const bad of ['{"items": [', '{items: [oops]}', 'I could not read that page.', '', null, undefined, 42]) {
    const out = parsePriceReply(bad);
    assert.deepEqual(out.items, [], `items for ${JSON.stringify(bad)}`);
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /JSON|no JSON|items/);
  }
});

test('reports a reply with no items array', () => {
  const { items, warnings } = parsePriceReply('{"prices": []}');
  assert.deepEqual(items, []);
  assert.match(warnings[0], /no "items" array/);
});

// --- a reply that stopped mid-JSON --------------------------------------
//
// Seen for real on a live OpenAI price fetch: the model's answer was correct as
// far as it got, but the reply was cut off, and the extractor reported "the
// model's reply had no items array" — because the unclosed outer object is not a
// balanced candidate, so the scan latched onto the first complete ROW instead,
// which of course has no `items` key. That message sent the reader hunting the
// prompt and the extractor for a fault that was neither.

const cutOff = (items, dropChars) => {
  const full = reply(items);
  return full.slice(0, full.length - dropChars);
};

test('a cut-off reply is named as cut off, not as "no items array"', () => {
  const { items, warnings } = parsePriceReply(cutOff([row({ evidence: 'x'.repeat(120) })], 150));
  assert.deepEqual(items, []);
  assert.match(warnings[0], /cut off/i);
  assert.equal(/no "items" array/.test(warnings[0]), false, 'the misleading message is gone');
});

test('complete rows before the cut are recovered rather than thrown away', () => {
  // A paid fetch over a 20k-character page should not be lost to a missing brace.
  const raw = cutOff(
    [
      row({ modelSlug: 'gpt-5', inPrice: 1.25, outPrice: 10, cachedInPrice: 0.125 }),
      row({ modelSlug: 'claude-sonnet', inPrice: 3, outPrice: 15, cachedInPrice: 0.3 }),
      row({ modelSlug: 'gemini-flash', inPrice: 0.3, outPrice: 2.5 }),
    ],
    120
  );
  const { items, warnings } = parsePriceReply(raw);
  assert.equal(items.length, 2, 'the two whole rows survive; the partial one is dropped');
  assert.deepEqual(items.map((i) => i.modelSlug), ['gpt-5', 'claude-sonnet']);
  assert.equal(items[0].cachedInPrice, 0.125, 'recovered rows keep their cache price');
  assert.equal(items[1].cachedInPrice, 0.3);
  assert.match(warnings[0], /cut off/i);
  assert.match(warnings[0], /2 complete row/);
  assert.match(warnings[0], /may list more prices/, 'a partial read must not read as a whole one');
});

test('a cut-off bare array (no "items" key) is recovered too', () => {
  const full = JSON.stringify([row({ modelSlug: 'gpt-5' }), row({ modelSlug: 'claude-sonnet' })]);
  const { items, warnings } = parsePriceReply(full.slice(0, full.length - 100));
  assert.equal(items.length, 1);
  assert.match(warnings[0], /cut off/i);
});

test('a row containing nested objects is recovered whole, not at its first brace', () => {
  const nested = row({ modelSlug: 'gpt-5', meta: { tier: { name: 'standard' } }, inPrice: 7 });
  const full = reply([nested, row({ modelSlug: 'claude-sonnet' })]);
  const { items } = parsePriceReply(full.slice(0, full.length - 90));
  assert.equal(items.length, 1);
  assert.equal(items[0].modelSlug, 'gpt-5');
  assert.equal(items[0].inPrice, 7, 'the nested object did not truncate the row');
});

test('a cut-off reply with nothing complete yet still says cut off', () => {
  const { items, warnings } = parsePriceReply('{"items": [{"modelSlug": "gpt-5", "inPr');
  assert.deepEqual(items, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /cut off/i);
});

test('a COMPLETE reply gains no cut-off warning', () => {
  const { items, warnings } = parsePriceReply(reply([row(), row({ modelSlug: 'gpt-5' })]));
  assert.equal(items.length, 2);
  assert.equal(warnings.some((w) => /cut off/i.test(w)), false);
});

test('genuinely broken JSON is still reported as broken, not as cut off', () => {
  // Balanced braces, so this is a syntax error rather than a truncation.
  const { items, warnings } = parsePriceReply('{"items": [oops]}');
  assert.deepEqual(items, []);
  assert.equal(/cut off/i.test(warnings[0]), false);
  assert.match(warnings[0], /not valid JSON|no "items" array/);
});

test('tolerates a bare array of rows', () => {
  const { items } = parsePriceReply(JSON.stringify([row()]));
  assert.equal(items.length, 1);
});

test('normalizes a per-1K page to per 1M', () => {
  const { items } = parsePriceReply(
    reply([row({ unit: 'per 1K tokens', inPrice: 0.00125, outPrice: 0.01, cachedInPrice: 0.000125 })])
  );
  assert.equal(items[0].inPrice, 1.25);
  assert.equal(items[0].outPrice, 10);
  assert.equal(items[0].cachedInPrice, 0.125);
  assert.equal(items[0].unit, 'per 1K tokens', 'the page’s unit is kept for the reviewer');
});

test('rejects implausible prices and names the row', () => {
  const { items, warnings } = parsePriceReply(
    reply([row({ label: 'Fantasy Model', inPrice: 25_000, outPrice: 12 })])
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].inPrice, null, 'the invented number is dropped');
  assert.equal(items[0].outPrice, 12, 'the plausible half of the row survives');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /implausible input price for "Fantasy Model"/);
});

test('the guard catches a unit misread once the 1000x lands past the ceiling', () => {
  // 15/1M is an ordinary output price; read as per-1K it becomes $15,000/1M.
  // The ceiling only catches the gross cases — smaller misreads are the
  // prompt's job (report the page's unit, never convert) and the reviewer's.
  const { items, warnings } = parsePriceReply(reply([row({ label: 'GPT-5', unit: 'per 1K tokens', outPrice: 15 })]));
  assert.equal(items[0].outPrice, null);
  assert.match(warnings.join(' '), /implausible output price for "GPT-5": \$15000 per 1M tokens/);
});

test('rejects negative prices with a warning', () => {
  const { items, warnings } = parsePriceReply(reply([row({ label: 'Rebate', inPrice: -3, outPrice: 10 })]));
  assert.equal(items[0].inPrice, null);
  assert.match(warnings[0], /negative input price \(-3\) for "Rebate"/);
});

test('drops a row with no input and no output price', () => {
  const { items, warnings } = parsePriceReply(
    reply([row({ label: 'Contact Sales Model', inPrice: null, outPrice: null, cachedInPrice: 0.1 })])
  );
  assert.deepEqual(items, []);
  assert.match(warnings[0], /"Contact Sales Model" had no usable input or output price/);
});

test('rejecting both prices drops the row rather than proposing an empty one', () => {
  const { items, warnings } = parsePriceReply(reply([row({ inPrice: -1, outPrice: 99_999 })]));
  assert.deepEqual(items, []);
  assert.equal(warnings.length, 3, 'one per rejected price, plus the drop');
});

test('reads string prices with currency symbols and thousands separators', () => {
  const { items } = parsePriceReply(reply([row({ inPrice: '$2.50', outPrice: '1,200' })]));
  assert.equal(items[0].inPrice, 2.5);
  assert.equal(items[0].outPrice, 1200);
});

test('a price string carrying its own unit text does not corrupt the number', () => {
  const { items } = parsePriceReply(reply([row({ inPrice: '$2.50 per 1M tokens', outPrice: '.75 USD' })]));
  assert.equal(items[0].inPrice, 2.5);
  assert.equal(items[0].outPrice, 0.75);
});

test('accepts the common field-name aliases', () => {
  const raw = JSON.stringify({
    items: [{ name: 'GPT-5', unit: 'per 1M tokens', input: 1.25, output: 10, cachedIn: 0.125 }],
  });
  const { items } = parsePriceReply(raw);
  assert.equal(items[0].label, 'GPT-5');
  assert.equal(items[0].inPrice, 1.25);
  assert.equal(items[0].outPrice, 10);
  assert.equal(items[0].cachedInPrice, 0.125);
});

test('flags a non-USD price instead of applying it as dollars', () => {
  const { items, warnings } = parsePriceReply(reply([row({ label: 'Euro Model', currency: 'eur' })]));
  assert.equal(items[0].currency, 'EUR');
  assert.match(warnings[0], /"Euro Model" is priced in EUR/);
});

test('clamps confidence into 0..1', () => {
  const conf = (v) => parsePriceReply(reply([row({ confidence: v })])).items[0].confidence;
  assert.equal(conf(0.42), 0.42);
  assert.equal(conf(95), 1);
  assert.equal(conf(-2), 0);
  assert.equal(conf('high'), null);
  assert.equal(conf(undefined), null);
});

test('truncates label and evidence to 300 chars', () => {
  const { items } = parsePriceReply(reply([row({ label: 'L'.repeat(500), evidence: 'E'.repeat(500) })]));
  assert.equal(items[0].label.length, 300);
  assert.equal(items[0].evidence.length, 300);
});

test('caps the proposal at 200 rows', () => {
  const many = Array.from({ length: 250 }, (_, i) => row({ label: `Model ${i}` }));
  const { items, warnings } = parsePriceReply(reply(many));
  assert.equal(items.length, 200);
  assert.match(warnings.join(' '), /250 rows; only the first 200/);
});

test('drops a non-object row without losing the rest', () => {
  const { items, warnings } = parsePriceReply(reply(['nonsense', row()]));
  assert.equal(items.length, 1);
  assert.match(warnings[0], /Row 1 of the reply was not an object/);
});

// --- matchProposalItems -------------------------------------------------

const matchOne = (item, warnings) => matchProposalItems({ items: [item], models: MODELS, warnings })[0];

test('matches on exact apiModel, case-insensitively', () => {
  const out = matchOne(row({ apiModel: 'GPT-5-2025-08-07', label: 'something else entirely' }));
  assert.equal(out.modelSlug, 'gpt-5');
  assert.equal(out.matchedBy, 'apiModel');
  assert.equal(out.currentIn, 1.25);
  assert.equal(out.currentOut, 10);
});

test('falls back to the registry slug when the page prints that instead', () => {
  const out = matchOne(row({ apiModel: 'Claude-Sonnet', label: 'unrelated' }));
  assert.equal(out.modelSlug, 'claude-sonnet');
  assert.equal(out.matchedBy, 'slug');
  assert.equal(out.currentOut, 15);
});

test('falls back to the normalized name of the apiModel field', () => {
  const out = matchOne(row({ apiModel: 'Claude Sonnet 4.5', label: 'unrelated' }));
  assert.equal(out.modelSlug, 'claude-sonnet');
  assert.equal(out.matchedBy, 'name');
});

test('falls back to the label against the model name', () => {
  const out = matchOne(row({ apiModel: null, label: 'gemini 2.5 flash!' }));
  assert.equal(out.modelSlug, 'gemini-flash');
  assert.equal(out.matchedBy, 'name');
  assert.equal(out.currentIn, 0.3);
});

test('leaves a model that is not in the registry unmatched', () => {
  const warnings = [];
  const out = matchOne(row({ modelSlug: null, apiModel: 'grok-9', label: 'Grok 9' }), warnings);
  assert.equal(out.modelSlug, null);
  assert.equal(out.matchedBy, null);
  assert.equal(out.currentIn, null);
  assert.deepEqual(warnings, [], 'a page listing a model we do not have is normal, not a warning');
});

test('keeps a modelSlug the model returned when it names a real model', () => {
  const out = matchOne(row({ modelSlug: 'gemini-flash', apiModel: 'gpt-5-2025-08-07' }));
  assert.equal(out.modelSlug, 'gemini-flash', 'the extractor saw the page; apiModel does not override it');
  assert.equal(out.matchedBy, 'slug');
  assert.equal(out.currentOut, 2.5);
});

test('clears a hallucinated modelSlug and warns', () => {
  const warnings = [];
  const out = matchOne(row({ modelSlug: 'gpt-6-turbo-ultra', apiModel: null, label: 'GPT-6' }), warnings);
  assert.equal(out.modelSlug, null);
  assert.equal(out.matchedBy, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"gpt-6-turbo-ultra", which is not a model in the registry/);
});

test('accepts registry model objects with price: { in, out }', () => {
  const [out] = matchProposalItems({
    items: [row({ apiModel: 'gpt-5-2025-08-07' })],
    models: [{ slug: 'gpt-5', name: 'GPT-5', apiModel: 'gpt-5-2025-08-07', price: { in: 1.25, out: 10 } }],
  });
  assert.equal(out.currentIn, 1.25);
  assert.equal(out.currentOut, 10);
});

test('matchProposalItems is safe with no models, no items and no warnings array', () => {
  assert.deepEqual(matchProposalItems({ items: null, models: null }), []);
  const [out] = matchProposalItems({ items: [row({ modelSlug: 'ghost' })], models: [] });
  assert.equal(out.modelSlug, null);
});

test('parse then match composes into rows ready for a PriceProposal', () => {
  const { items, warnings } = parsePriceReply(
    reply([row({ unit: 'per 1K tokens', inPrice: 0.003, outPrice: 0.015, apiModel: 'claude-sonnet-4-5' })])
  );
  const matched = matchProposalItems({ items, models: MODELS, warnings });
  assert.deepEqual(
    { slug: matched[0].modelSlug, by: matched[0].matchedBy, in: matched[0].inPrice, was: matched[0].currentIn },
    { slug: 'claude-sonnet', by: 'apiModel', in: 3, was: 3 }
  );
});

test('a cached-input price above the input price is treated as swapped columns', () => {
  // Kimi's K3 page is headed "Input (Cache Hit) | Input (Cache Miss) | Output", and
  // an extractor that reads them left-to-right reports the discounted rate as the
  // input price — understating the real cost tenfold.
  const { items, warnings } = parsePriceReply(
    JSON.stringify({
      items: [
        {
          modelSlug: 'kimi-k3',
          label: 'kimi-k3',
          unit: 'per 1M tokens',
          inPrice: 0.3,
          outPrice: 15,
          cachedInPrice: 3,
          confidence: 1,
        },
      ],
    })
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].inPrice, 3, 'the larger figure is the uncached input price');
  assert.equal(items[0].cachedInPrice, 0.3, 'the smaller figure is the cache-hit price');
  assert.equal(items[0].outPrice, 15);
  assert.ok(
    warnings.some((w) => /swapped back/i.test(w)),
    'the correction must be reported, not applied silently'
  );
});

test('a correctly-ordered cached price is left alone', () => {
  const { items, warnings } = parsePriceReply(
    JSON.stringify({
      items: [
        { modelSlug: 'kimi-k2.6', label: 'kimi-k2.6', unit: 'per 1M tokens', inPrice: 0.95, outPrice: 4, cachedInPrice: 0.16 },
      ],
    })
  );
  assert.equal(items[0].inPrice, 0.95);
  assert.equal(items[0].cachedInPrice, 0.16);
  assert.ok(!warnings.some((w) => /swapped back/i.test(w)));
});
