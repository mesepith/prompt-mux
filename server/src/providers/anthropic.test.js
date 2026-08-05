/**
 * Unit tests for the Anthropic message mapper.
 * Run: npm --prefix server test
 *
 * Only one thing here is worth pinning, and it is worth pinning hard: Anthropic
 * caches NOTHING without an explicit `cache_control` block, unlike every
 * OpenAI-compatible vendor, which caches long prefixes on its own. If the
 * boundary marker silently stops being emitted there is no error and no visible
 * change — just a bill that quietly pays full price to re-read the same chat
 * history on every single turn.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { toAnthropicMessage } from './anthropic.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

test('an ordinary text message stays a plain string (nothing to cache)', () => {
  assert.deepEqual(toAnthropicMessage({ role: 'user', content: 'hello' }), {
    role: 'user',
    content: 'hello',
  });
});

test('the cache boundary promotes a string message to a marked content block', () => {
  const mapped = toAnthropicMessage({ role: 'assistant', content: 'prior turn', cacheBoundary: true });
  assert.deepEqual(mapped, {
    role: 'assistant',
    content: [{ type: 'text', text: 'prior turn', cache_control: { type: 'ephemeral' } }],
  });
});

test('a message with images keeps its image blocks and marks only the text block', () => {
  const mapped = toAnthropicMessage({
    role: 'user',
    content: 'look at this',
    images: [PNG],
    cacheBoundary: true,
  });
  assert.equal(mapped.content.length, 2);
  assert.equal(mapped.content[0].type, 'image');
  assert.equal(mapped.content[0].cache_control, undefined, 'the marker goes on one block only');
  assert.equal(mapped.content[1].type, 'text');
  assert.deepEqual(mapped.content[1].cache_control, { type: 'ephemeral' });
});

test('images without the boundary carry no cache_control at all', () => {
  const mapped = toAnthropicMessage({ role: 'user', content: 'hi', images: [PNG] });
  assert.equal(JSON.stringify(mapped).includes('cache_control'), false);
});

test('an empty message body still produces a valid block', () => {
  const mapped = toAnthropicMessage({ role: 'user', content: '', cacheBoundary: true });
  assert.equal(mapped.content[0].text, '');
  assert.deepEqual(mapped.content[0].cache_control, { type: 'ephemeral' });
});

test('exactly one boundary per request is what the route should produce', () => {
  // Anthropic allows a handful of breakpoints, but each one costs a write at
  // 1.25x. The route marks the message before the newest — the part that is
  // byte-identical next turn — and nothing else.
  const conversation = [
    { role: 'user', content: 'make a game' },
    { role: 'assistant', content: '[html artifact, 19804 chars]' },
    { role: 'user', content: 'add floating walls', cacheBoundary: true },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'now make them wider' },
  ];
  const marked = conversation
    .map(toAnthropicMessage)
    .filter((m) => JSON.stringify(m).includes('cache_control'));
  assert.equal(marked.length, 1);
});
