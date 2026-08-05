/**
 * Unit tests for the artifact outline.
 * Run: npm --prefix server test
 *
 * The outline is navigation help for a model, so the properties that matter are
 * structural: parts must cover the file without overlapping, line numbers must
 * be real, and the JS half of the document must be visible — that is the half
 * point-and-edit cannot reach and where a game's bugs actually live.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArtifactMap, renderArtifactMap } from './artifactMap.js';

const GAME = `<!DOCTYPE html>
<html>
<head>
<style>
  body { margin: 0; }
  .hud { color: white; }
</style>
</head>
<body>
<canvas id="game"></canvas>
<div id="hud">Score: 0</div>
<script>
  const GRAVITY = 0.5;
  let score = 0;

  // ===== physics =====
  function update() {
    player.vy += GRAVITY;
  }

  const draw = () => {
    ctx.clearRect(0, 0, W, H);
  };

  class Sprite {
    constructor() {}
  }
</script>
</body>
</html>`;

const byName = (parts, needle) => parts.find((p) => p.name.includes(needle));

test('the outline covers the file in order, with no gaps or overlaps', () => {
  const parts = buildArtifactMap(GAME);
  assert.ok(parts.length >= 6, `expected a useful outline, got ${parts.length}`);
  assert.equal(parts[0].startLine, 1);
  assert.equal(parts[parts.length - 1].endLine, GAME.split('\n').length);
  for (let i = 0; i < parts.length; i++) {
    assert.equal(parts[i].n, i + 1, 'numbered from 1');
    assert.ok(parts[i].endLine >= parts[i].startLine, 'a part never ends before it starts');
    assert.equal(parts[i].lines, parts[i].endLine - parts[i].startLine + 1);
    if (i > 0) assert.equal(parts[i].startLine, parts[i - 1].endLine + 1, 'parts are contiguous');
  }
});

test('the JS half is broken out by function, arrow, class and section comment', () => {
  const parts = buildArtifactMap(GAME);
  assert.ok(byName(parts, 'update()'), 'a plain function is a part');
  assert.ok(byName(parts, 'draw()'), 'an arrow function assigned to a const is a part');
  assert.ok(byName(parts, 'class Sprite'), 'a class is a part');
  assert.ok(byName(parts, 'physics'), 'a decorated section comment is a heading');
  assert.ok(byName(parts, 'script — setup'), 'the code before the first function is its own part');
});

test('styles and identified elements are found', () => {
  const parts = buildArtifactMap(GAME);
  const style = byName(parts, 'styles');
  assert.ok(style);
  const lines = GAME.split('\n');
  assert.match(lines[style.startLine - 1], /<style/);
  assert.match(lines[style.endLine - 1], /<\/style>/);
  assert.ok(byName(parts, '#game <canvas>'));
  assert.ok(byName(parts, '#hud <div>'));
});

test('line numbers point at the real lines', () => {
  const parts = buildArtifactMap(GAME);
  const lines = GAME.split('\n');
  const update = byName(parts, 'update()');
  assert.match(lines[update.startLine - 1], /function update\(\)/);
  const sprite = byName(parts, 'class Sprite');
  assert.match(lines[sprite.startLine - 1], /class Sprite/);
});

test('an undecorated comment is NOT treated as a heading', () => {
  const code = '<script>\n  // just explaining something\n  const a = 1;\n</script>';
  const parts = buildArtifactMap(code);
  assert.equal(byName(parts, 'just explaining'), undefined);
});

test('a one-line <style> and a one-line <script> do not swallow the rest of the file', () => {
  const code = '<div>a</div>\n<style>p{color:red}</style>\n<div id="x">b</div>\n<script>go()</script>\n<div>c</div>';
  const parts = buildArtifactMap(code);
  assert.equal(parts[parts.length - 1].endLine, 5, 'the file is fully covered');
  const style = byName(parts, 'styles');
  assert.equal(style.startLine, 2);
  assert.equal(style.endLine, 2, 'closed on its own line');
  assert.ok(byName(parts, '#x <div>'), 'markup after a one-line style is still scanned');
});

test('an unclosed <script> runs to the end rather than dropping the tail', () => {
  const code = '<div>a</div>\n<script>\n  const a = 1;';
  const parts = buildArtifactMap(code);
  assert.equal(parts[parts.length - 1].endLine, 3);
});

test('empty and junk input produce no outline instead of throwing', () => {
  assert.deepEqual(buildArtifactMap(''), []);
  assert.deepEqual(buildArtifactMap(null), []);
  assert.deepEqual(buildArtifactMap('   \n  '), []);
});

test('a pathological number of ids is capped, keeping the structural parts', () => {
  const many = Array.from({ length: 200 }, (_, i) => `<div id="d${i}">x</div>`).join('\n');
  const code = `${many}\n<script>\n  function go() {}\n</script>`;
  const parts = buildArtifactMap(code);
  assert.ok(parts.length <= 40, `capped, got ${parts.length}`);
  assert.ok(byName(parts, 'go()'), 'the script survived the cull, the div list did not');
});

test('the rendered outline is compact text, and skipped when there is nothing to navigate', () => {
  const text = renderArtifactMap(buildArtifactMap(GAME));
  assert.match(text, /^1\. lines 1-\d+ — /);
  assert.match(text, /update\(\)/);
  assert.equal(text.split('\n').length, buildArtifactMap(GAME).length);
  assert.equal(renderArtifactMap([]), '', 'no outline for nothing');
  assert.equal(renderArtifactMap(buildArtifactMap('<p>one part only, nothing to map</p>')), '');
});
