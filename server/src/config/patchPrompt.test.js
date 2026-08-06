/**
 * Unit tests for the injected artifact context.
 * Run: npm --prefix server test
 *
 * One property carries this whole file: NOTHING VARIABLE MAY APPEAR ABOVE THE
 * SOURCE. A prompt cache only ever reuses a prefix, so the first byte that
 * differs between two turns is where the saving stops. An earlier version opened
 * with `… "My Game": HTML, 618 lines.` and that line count alone moved the
 * divergence ~70 tokens in, leaving the ~4,900-token source behind it
 * permanently uncacheable — 0 hits, measured, on a real chat.
 *
 * The failure is silent: the prompt still reads fine, the model still answers,
 * and only the bill knows. Hence tests rather than a comment.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArtifactContext, END_OF_SOURCE, PATCH_RULES, ARTIFACT_SOURCE_MAX } from './patchPrompt.js';

const GAME = `<!DOCTYPE html>
<html><head><style>
  body { margin: 0; }
</style></head>
<body>
<canvas id="game"></canvas>
<script>
  const JUMP = 8;
  function update() { player.vy += 1; }
</script>
</body></html>`;

const ctx = (over = {}) =>
  buildArtifactContext({ code: GAME, language: 'html', title: 'Mini Mario', outline: '1. lines 1-5 — styles', ...over });

/** Characters two prompts share from the start — what a cache can actually reuse. */
const sharedPrefix = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

test('the source starts before anything variable', () => {
  const text = ctx();
  const sourceAt = text.indexOf('<!DOCTYPE html>');
  assert.ok(sourceAt !== -1);
  const head = text.slice(0, sourceAt);
  assert.equal(head.includes('Mini Mario'), false, 'the title must not precede the source');
  assert.equal(/\d+ lines/.test(head), false, 'the line count must not precede the source');
  assert.equal(head.includes('Outline'), false, 'the outline must not precede the source');
  assert.equal(head.includes('HTML'), false, 'even the language must not precede the source');
});

test('two versions of the same artifact share everything up to the first changed line', () => {
  const edited = GAME.replace('const JUMP = 8;', 'const JUMP = 13;');
  const before = ctx();
  const after = ctx({ code: edited });
  const shared = sharedPrefix(before, after);
  // The edit is near the bottom, so almost the whole document should be shared.
  const upToEdit = ctx().indexOf('const JUMP = 8;');
  assert.ok(shared >= upToEdit, `shared ${shared} should reach the edit at ${upToEdit}`);
  assert.ok(shared > 150, 'a real prefix, not just a header');
});

test('an added line does NOT shorten the shared prefix (the line-count trap)', () => {
  // Adding a line changes the line count and every later outline row. When those
  // sat above the source this dropped the shared prefix to ~70 characters.
  const grown = GAME.replace('  const JUMP = 8;', '  const JUMP = 8;\n  const SPEED = 3;');
  const shared = sharedPrefix(
    ctx(),
    ctx({ code: grown, outline: '1. lines 1-5 — styles\n2. lines 6-9 — update()' })
  );
  const upToEdit = ctx().indexOf('  const JUMP = 8;');
  assert.ok(shared >= upToEdit, `shared ${shared} must still reach ${upToEdit}`);
});

test('the fixed header is byte-identical for different artifacts, languages and titles', () => {
  const a = buildArtifactContext({ code: GAME, language: 'html', title: 'One', outline: 'x' });
  const b = buildArtifactContext({ code: '<svg><circle r="4"/></svg>', language: 'svg', title: 'Two', outline: 'y' });
  assert.equal(a.split('\n')[0], b.split('\n')[0], 'the first line never varies');
  assert.ok(sharedPrefix(a, b) >= a.split('\n')[0].length);
});

test('the rewrite variant differs only AFTER the source', () => {
  // The fallback asks for the opposite of what the patch call asks for, but it
  // re-sends the same document — so that difference must not cost the prefix.
  const patch = ctx();
  const rewrite = ctx({ rewrite: true });
  const shared = sharedPrefix(patch, rewrite);
  const sourceEnd = patch.indexOf('</html>') + '</html>'.length;
  assert.ok(shared >= sourceEnd, `shared ${shared} must cover the whole source (ends ${sourceEnd})`);
  assert.match(rewrite, /COMPLETE updated document/);
  assert.equal(/COMPLETE updated document/.test(patch), false);
});

test('the model still gets the outline, line count and instruction, just after the code', () => {
  const text = ctx();
  assert.match(text, /Outline:/);
  assert.match(text, /1\. lines 1-5 — styles/);
  assert.match(text, /11 lines/);
  assert.match(text, /"Mini Mario"/);
  assert.match(text, /Change it with edit blocks; do not reproduce it/);
});

test('the user-message marker is last, so the request is not buried in code', () => {
  const text = ctx();
  assert.ok(text.trimEnd().endsWith(END_OF_SOURCE), 'the marker closes the block');
  assert.ok(text.indexOf(END_OF_SOURCE) > text.indexOf('</html>'), 'and comes after the source');
});

test('an oversized artifact is truncated and says so, still after the source', () => {
  const huge = `${'<p>x</p>\n'.repeat(20_000)}`;
  const text = buildArtifactContext({ code: huge, language: 'html', title: 'Big' });
  assert.ok(huge.length > ARTIFACT_SOURCE_MAX);
  assert.match(text, /middle of the source above was omitted/);
  assert.ok(text.indexOf('omitted') > text.indexOf('<p>x</p>'));
});

test('no code means no block at all', () => {
  assert.equal(buildArtifactContext({ code: '', language: 'html' }), '');
  assert.equal(buildArtifactContext({ code: null, language: 'html' }), '');
});

test('the patch rules are always sent, so the system prompt never grows mid-chat', () => {
  // A system prompt that gains text once an artifact exists moves the very first
  // bytes of the prompt and throws away the entire cache — seen on a real
  // 18,923-token turn that scored 0 hits.
  assert.match(PATCH_RULES, /If this chat already has an artifact/);
  assert.equal(/^This chat already has an artifact/m.test(PATCH_RULES), false);
});
