/**
 * Unit tests for the registry diff. Run: npm --prefix server test
 *
 * Only diffAgainstRegistry is covered — the discovery calls themselves are
 * network-bound. This function decides what the admin dashboard offers to add or
 * retire, so a wrong bucket either hides a dead model id or invites deleting a
 * live one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { diffAgainstRegistry, supportsDiscovery } from './modelDiscovery.js';

const registry = [
  { id: 'gpt-5', apiModel: 'gpt-5', name: 'GPT-5' },
  { id: 'gpt-4o', apiModel: 'gpt-4o', name: 'GPT-4o' },
  { id: 'gpt-legacy', apiModel: 'gpt-4-0314', name: 'GPT-4 (old)' },
];

test('splits into known, retired and new', () => {
  const diff = diffAgainstRegistry(['gpt-5', 'gpt-4o', 'gpt-5-mini'], registry);
  assert.deepEqual(diff.known, [
    { slug: 'gpt-5', apiModel: 'gpt-5', name: 'GPT-5' },
    { slug: 'gpt-4o', apiModel: 'gpt-4o', name: 'GPT-4o' },
  ]);
  assert.deepEqual(diff.missingFromProvider, [
    { slug: 'gpt-legacy', apiModel: 'gpt-4-0314', name: 'GPT-4 (old)' },
  ]);
  assert.deepEqual(diff.newFromProvider, ['gpt-5-mini']);
});

test('matching ignores case, and the provider spelling is what is reported', () => {
  const diff = diffAgainstRegistry(['GPT-5', 'GPT-4O', 'GPT-4-0314', 'O3-Pro'], registry);
  assert.deepEqual(
    diff.known.map((m) => m.slug),
    ['gpt-5', 'gpt-4o', 'gpt-legacy']
  );
  assert.deepEqual(diff.missingFromProvider, []);
  assert.deepEqual(diff.newFromProvider, ['O3-Pro'], 'kept as the provider wrote it');
});

test('newFromProvider is sorted and de-duplicated', () => {
  const diff = diffAgainstRegistry(['zeta', 'alpha', 'ALPHA', 'mid'], []);
  assert.deepEqual(diff.newFromProvider, ['alpha', 'mid', 'zeta']);
});

test('no ids means every registry model looks retired, and nothing is new', () => {
  const diff = diffAgainstRegistry([], registry);
  assert.equal(diff.known.length, 0);
  assert.deepEqual(
    diff.missingFromProvider.map((m) => m.slug),
    ['gpt-5', 'gpt-4o', 'gpt-legacy']
  );
  assert.deepEqual(diff.newFromProvider, []);
});

test('an empty registry makes every served id new', () => {
  const diff = diffAgainstRegistry(['gpt-5', 'gpt-4o'], []);
  assert.deepEqual(diff, {
    known: [],
    missingFromProvider: [],
    newFromProvider: ['gpt-4o', 'gpt-5'],
  });
});

test('missing arguments are tolerated — the admin UI can call this before a fetch', () => {
  assert.deepEqual(diffAgainstRegistry(), {
    known: [],
    missingFromProvider: [],
    newFromProvider: [],
  });
});

test('a registry model with no apiModel counts as retired, never as a match', () => {
  const diff = diffAgainstRegistry(['gpt-5'], [{ id: 'broken', apiModel: '', name: 'Broken' }]);
  assert.deepEqual(diff.missingFromProvider, [{ slug: 'broken', apiModel: '', name: 'Broken' }]);
  assert.deepEqual(diff.newFromProvider, ['gpt-5']);
});

test('the input arrays are not mutated (pure function)', () => {
  const ids = ['gpt-5', 'gpt-5-mini'];
  const models = registry.map((m) => ({ ...m }));
  diffAgainstRegistry(ids, models);
  assert.deepEqual(ids, ['gpt-5', 'gpt-5-mini']);
  assert.deepEqual(models, registry);
});

test('discovery is offered for the adapters that have a listing API', () => {
  for (const adapter of ['openai', 'anthropic', 'google', 'demo']) {
    assert.equal(supportsDiscovery({ adapter }), true, adapter);
  }
  assert.equal(supportsDiscovery({ adapter: 'made-up' }), false);
  assert.equal(supportsDiscovery(null), false);
});
