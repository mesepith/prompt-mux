/**
 * Unit tests for SEARCH/REPLACE patches.
 * Run: npm --prefix server test
 *
 * Two properties are load-bearing, and most of this file exists to pin them:
 *
 *  1. Everything OUTSIDE a hunk comes out byte-identical. That is the whole
 *     promise of "it won't quietly redesign the parts you liked".
 *  2. An edit that cannot be placed EXACTLY ONCE is refused, and refusing leaves
 *     the document untouched — never half-edited.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePatch,
  applyPatch,
  patchStats,
  hunksForStorage,
  describeFailures,
  patchMarkerIndex,
  SNIFF_HOLDBACK,
} from './patch.js';

const GAME = `<!DOCTYPE html>
<html>
<head>
<style>
  body { margin: 0; background: #111; }
  .hud { color: white; }
</style>
</head>
<body>
<canvas id="game"></canvas>
<script>
  const GRAVITY = 0.5;
  const JUMP = 8;
  let score = 0;

  function update() {
    player.vy += GRAVITY;
    player.y += player.vy;
    if (player.y > FLOOR) {
      player.y = FLOOR;
      player.vy = 0;
    }
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillRect(player.x, player.y, 20, 20);
  }
</script>
</body>
</html>`;

const patchText = (search, replace) =>
  `\`\`\`patch\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n\`\`\``;

// ---------------------------------------------------------------- parsing

test('a fenced block is parsed into one hunk with the prose kept', () => {
  const raw = `Made the jump higher.\n\n${patchText('  const JUMP = 8;', '  const JUMP = 13;')}`;
  const { prose, blocks, problems } = parsePatch(raw);
  assert.equal(problems.length, 0);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].search, '  const JUMP = 8;');
  assert.equal(blocks[0].replace, '  const JUMP = 13;');
  assert.equal(prose, 'Made the jump higher.');
  assert.equal(prose.includes('```'), false, 'the wrapper fence is not shown to the user');
});

test('bare markers with no fence and no SEARCH/REPLACE words still parse', () => {
  const { blocks, problems } = parsePatch('<<<<<<<\nold line\n=======\nnew line\n>>>>>>>');
  assert.equal(problems.length, 0);
  assert.deepEqual(blocks, [{ search: 'old line', replace: 'new line' }]);
});

test('longer marker runs parse (models drift on marker length)', () => {
  const { blocks } = parsePatch('<<<<<<<<<<< SEARCH\na\n==========\nb\n>>>>>>>>>>> REPLACE');
  assert.deepEqual(blocks, [{ search: 'a', replace: 'b' }]);
});

test('several hunks in one reply are all collected, in order', () => {
  const raw = [
    'Two changes.',
    '```patch',
    '<<<<<<< SEARCH', 'a1', '=======', 'b1', '>>>>>>> REPLACE',
    '<<<<<<< SEARCH', 'a2', '=======', 'b2', '>>>>>>> REPLACE',
    '```',
  ].join('\n');
  const { blocks, prose } = parsePatch(raw);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((b) => b.search), ['a1', 'a2']);
  assert.equal(prose, 'Two changes.');
});

test('a comment line of equals signs inside SEARCH is not read as the divider', () => {
  // The exact reason markers must own their whole line: this is ordinary code.
  const raw = '<<<<<<< SEARCH\n  // ===== physics =====\n  const G = 1;\n=======\n  // ===== physics =====\n  const G = 2;\n>>>>>>> REPLACE';
  const { blocks, problems } = parsePatch(raw);
  assert.equal(problems.length, 0);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].search, /\/\/ ===== physics =====/);
  assert.match(blocks[0].replace, /const G = 2;/);
});

test('an empty REPLACE section parses as a deletion', () => {
  const { blocks, problems } = parsePatch('<<<<<<< SEARCH\n  debugDraw();\n=======\n>>>>>>> REPLACE');
  assert.equal(problems.length, 0);
  assert.deepEqual(blocks, [{ search: '  debugDraw();', replace: '' }]);
});

test('an empty SEARCH section is rejected — there is nothing to locate', () => {
  const { blocks, problems } = parsePatch('<<<<<<< SEARCH\n=======\nnew stuff\n>>>>>>> REPLACE');
  assert.equal(blocks.length, 0);
  assert.match(problems.join(' '), /empty SEARCH/);
});

test('an unterminated block is reported, not half-applied', () => {
  const { blocks, problems } = parsePatch('<<<<<<< SEARCH\nold\n=======\nnew');
  assert.equal(blocks.length, 0);
  assert.match(problems.join(' '), /cut off/);
});

test('a missing divider is reported', () => {
  const { blocks, problems } = parsePatch('<<<<<<< SEARCH\nold\n>>>>>>> REPLACE');
  assert.equal(blocks.length, 0);
  assert.match(problems.join(' '), /divider/);
});

test('an ordinary answer with no blocks yields no blocks and keeps its fences', () => {
  const raw = 'The jump is controlled by JUMP:\n\n```js\nconst JUMP = 8;\n```';
  const { blocks, prose } = parsePatch(raw);
  assert.equal(blocks.length, 0);
  assert.equal(prose.includes('```js'), true, 'a normal reply is left completely alone');
});

test('CRLF line endings from a model are normalized', () => {
  const { blocks } = parsePatch('<<<<<<< SEARCH\r\nold\r\n=======\r\nnew\r\n>>>>>>> REPLACE\r\n');
  assert.deepEqual(blocks, [{ search: 'old', replace: 'new' }]);
});

// ---------------------------------------------------------------- applying

test('a unique hunk applies and everything else is byte-identical', () => {
  const { blocks } = parsePatch(patchText('  const JUMP = 8;', '  const JUMP = 13;'));
  const result = applyPatch(GAME, blocks);
  assert.equal(result.ok, true);
  assert.match(result.code, /const JUMP = 13;/);
  // The load-bearing property: only the hunk moved.
  assert.equal(result.code, GAME.replace('  const JUMP = 8;', '  const JUMP = 13;'));
  assert.equal(result.code.length, GAME.length + 1);
});

test('a part-of-a-line match keeps the surrounding indentation', () => {
  const { blocks } = parsePatch(patchText('const GRAVITY = 0.5;', 'const GRAVITY = 0.8;'));
  const result = applyPatch(GAME, blocks);
  assert.equal(result.ok, true);
  assert.match(result.code, /^ {2}const GRAVITY = 0\.8;$/m, 'the two-space indent survived');
});

test('lines that appear twice are refused rather than guessed at', () => {
  const twice = 'a\nSAME\nb\nSAME\nc';
  const { blocks } = parsePatch(patchText('SAME', 'CHANGED'));
  const result = applyPatch(twice, blocks);
  assert.equal(result.ok, false);
  assert.equal(result.code, twice, 'the document is untouched');
  assert.match(result.failures[0].reason, /more than once/);
});

test('lines that are not there are refused', () => {
  const { blocks } = parsePatch(patchText('  const JUMP = 99;', '  const JUMP = 1;'));
  const result = applyPatch(GAME, blocks);
  assert.equal(result.ok, false);
  assert.equal(result.code, GAME);
  assert.match(result.failures[0].reason, /not in the document/);
});

test('trailing-whitespace drift is forgiven', () => {
  const { blocks } = parsePatch(patchText('  const JUMP = 8;   ', '  const JUMP = 13;'));
  const result = applyPatch(GAME, blocks);
  assert.equal(result.ok, true);
  assert.equal(result.applied[0].strategy, 'trailing-space');
  assert.match(result.code, /const JUMP = 13;/);
});

test('indentation drift is forgiven and the file\'s own indentation is used', () => {
  // The model wrote no indentation; the file uses two spaces.
  const { blocks } = parsePatch(patchText('const JUMP = 8;\nlet score = 0;', 'const JUMP = 13;\nlet score = 0;'));
  const result = applyPatch(GAME, blocks);
  assert.equal(result.ok, true);
  assert.equal(result.applied[0].strategy, 'indent');
  assert.match(result.code, /^ {2}const JUMP = 13;$/m, 'reindented to the file, not flattened');
  assert.match(result.code, /^ {2}let score = 0;$/m);
});

test('indentation drift keeps relative nesting inside the replacement', () => {
  const code = 'function f() {\n    if (a) {\n        go();\n    }\n}';
  // Model indents with 2 where the file uses 4, and adds a nested line.
  const { blocks } = parsePatch(
    patchText('  if (a) {\n    go();\n  }', '  if (a) {\n    go();\n    stop();\n  }')
  );
  const result = applyPatch(code, blocks);
  assert.equal(result.ok, true);
  assert.equal(result.applied[0].strategy, 'indent');
  const lines = result.code.split('\n');
  assert.equal(lines[1], '    if (a) {', 'base indent taken from the file');
  assert.equal(lines[2], '        go();', 'relative nesting preserved');
  assert.equal(lines[3], '        stop();', 'the new line lands at the same depth');
  assert.equal(lines[4], '    }');
});

test('a deletion removes the lines outright', () => {
  const code = 'one\ntwo\nthree';
  const { blocks } = parsePatch('<<<<<<< SEARCH\ntwo\n=======\n>>>>>>> REPLACE');
  const result = applyPatch(code, blocks);
  assert.equal(result.ok, true);
  assert.equal(result.code, 'one\nthree', 'no blank line left behind');
});

test('several hunks all apply, and only where they should', () => {
  const raw = [
    '```patch',
    '<<<<<<< SEARCH', '  const JUMP = 8;', '=======', '  const JUMP = 13;', '>>>>>>> REPLACE',
    '<<<<<<< SEARCH', '  .hud { color: white; }', '=======', '  .hud { color: gold; }', '>>>>>>> REPLACE',
    '```',
  ].join('\n');
  const { blocks } = parsePatch(raw);
  const result = applyPatch(GAME, blocks);
  assert.equal(result.ok, true);
  assert.equal(
    result.code,
    GAME.replace('  const JUMP = 8;', '  const JUMP = 13;').replace('  .hud { color: white; }', '  .hud { color: gold; }')
  );
  assert.equal(result.applied.length, 2);
});

test('a later hunk may target what an earlier one produced', () => {
  const raw = [
    '<<<<<<< SEARCH', 'alpha', '=======', 'beta', '>>>>>>> REPLACE',
    '<<<<<<< SEARCH', 'beta', '=======', 'gamma', '>>>>>>> REPLACE',
  ].join('\n');
  const { blocks } = parsePatch(raw);
  const result = applyPatch('start\nalpha\nend', blocks);
  assert.equal(result.ok, true);
  assert.equal(result.code, 'start\ngamma\nend');
});

test('ONE bad hunk out of three applies NOTHING', () => {
  const raw = [
    '<<<<<<< SEARCH', '  const JUMP = 8;', '=======', '  const JUMP = 13;', '>>>>>>> REPLACE',
    '<<<<<<< SEARCH', '  const NOPE = 1;', '=======', '  const NOPE = 2;', '>>>>>>> REPLACE',
    '<<<<<<< SEARCH', '  let score = 0;', '=======', '  let score = 100;', '>>>>>>> REPLACE',
  ].join('\n');
  const { blocks } = parsePatch(raw);
  const result = applyPatch(GAME, blocks);
  assert.equal(result.ok, false);
  assert.equal(result.code, GAME, 'the working game is left exactly as it was');
  assert.equal(result.applied.length, 0);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].index, 1, 'the caller is told which hunk missed');
});

test('a whole-document SEARCH still only replaces the document', () => {
  // Wasteful, but it must not corrupt anything.
  const { blocks } = parsePatch(patchText(GAME, '<p>tiny</p>'));
  const result = applyPatch(GAME, blocks);
  assert.equal(result.ok, true);
  assert.equal(result.code, '<p>tiny</p>');
});

test('no artifact and no blocks both fail cleanly', () => {
  assert.equal(applyPatch('', [{ search: 'a', replace: 'b' }]).ok, false);
  assert.equal(applyPatch(GAME, []).ok, false);
  assert.equal(applyPatch(GAME, null).ok, false);
  assert.equal(applyPatch(null, [{ search: 'a', replace: 'b' }]).ok, false);
  // Failing must never mutate or lose the document.
  assert.equal(applyPatch(GAME, []).code, GAME);
});

test('the document survives a hunk whose replacement is identical', () => {
  const { blocks } = parsePatch(patchText('  const JUMP = 8;', '  const JUMP = 8;'));
  const result = applyPatch(GAME, blocks);
  assert.equal(result.ok, true);
  assert.equal(result.code, GAME, 'a no-op edit is a no-op, not a corruption');
});

test('a replacement containing a markdown fence is refused, not stored', () => {
  // The artifact lives inside a ```html fence. A fence in the code would truncate
  // it for every future read — the panel, point-and-edit and /a/<id> pages all.
  const { blocks } = parsePatch(
    '<<<<<<< SEARCH\n  const JUMP = 8;\n=======\n  const HELP = `\ntype ```js to start\n`;\n>>>>>>> REPLACE'
  );
  const result = applyPatch(GAME, blocks);
  assert.equal(result.ok, false);
  assert.equal(result.code, GAME);
  assert.match(result.failures[0].reason, /code fence/);
});

test('a patch that would shrink the artifact out of existence is refused', () => {
  // Found by review, and it is the nastiest failure in this feature: the fence
  // would still be stored, extractArtifacts would skip anything under
  // MIN_ARTIFACT_CHARS, the panel would show nothing — and the NEXT turn would
  // pick up the previous version, so the user would silently edit an old copy.
  const { blocks } = parsePatch(patchText(GAME, '<p>x</p>'));
  const guarded = applyPatch(GAME, blocks, { minLength: 30 });
  assert.equal(guarded.ok, false);
  assert.equal(guarded.code, GAME, 'the game is left exactly as it was');
  assert.match(guarded.failures[0].reason, /would delete the artifact/);
  // Without a limit it is allowed — the guard belongs to the caller that has to
  // store the result, not to text surgery in general.
  assert.equal(applyPatch(GAME, blocks).ok, true);
});

test('the shrink guard measures the result, not the size of the edit', () => {
  // A big trim is fine as long as what's left is still an artifact.
  const keep = '<!DOCTYPE html>\n<html><body>\n';
  const code = `${keep}${Array.from({ length: 40 }, (_, i) => `<p>paragraph number ${i}</p>`).join('\n')}\n</body></html>`;
  const { blocks } = parsePatch(
    patchText('<p>paragraph number 0</p>', '<p>the only paragraph left standing</p>')
  );
  const result = applyPatch(code, blocks, { minLength: 30 });
  assert.equal(result.ok, true);
  assert.match(result.code, /the only paragraph left standing/);
  assert.ok(result.code.trim().length >= 30);
});

// ------------------------------------------------------- the streaming sniffer

test('the sniffer finds every marker shape a model might emit', () => {
  assert.equal(patchMarkerIndex('Making a change.\n<<<<<<< SEARCH\nold'), 16);
  assert.equal(patchMarkerIndex('<<<<<<< SEARCH\nold'), 0, 'a marker in the very first delta');
  assert.equal(patchMarkerIndex('ok\n```patch\n<<<<<<<'), 2, 'the fence is caught before the marker');
  assert.equal(patchMarkerIndex('ok\n  ```diff\n'), 2, 'indented fence');
  assert.equal(patchMarkerIndex('ok\n\t\t<<<<<<<'), 2, 'indented marker');
});

test('the sniffer does not fire on ordinary prose or code', () => {
  assert.equal(patchMarkerIndex('The jump is set by JUMP = 8.'), -1);
  assert.equal(patchMarkerIndex('Use a << b for a bit shift.'), -1, 'two angle brackets are not a marker');
  assert.equal(patchMarkerIndex('```js\nconst a = 1;\n```'), -1, 'a normal code fence is not a patch');
  assert.equal(patchMarkerIndex('a <<<< b'), -1, 'four is below the threshold');
});

test('the holdback covers the longest marker the sniffer accepts', () => {
  const longest = '\n    ```patch\n';
  assert.ok(SNIFF_HOLDBACK >= longest.length, `${SNIFF_HOLDBACK} must cover ${longest.length}`);
});

// ---------------------------------------------------------------- reporting

test('stats count the lines that moved', () => {
  const stats = patchStats([
    { search: 'a\nb', replace: 'c' },
    { search: 'x', replace: '' },
  ]);
  assert.deepEqual(stats, { hunks: 2, added: 1, removed: 3 });
});

test('failures are described in words the model can act on', () => {
  const text = describeFailures(
    [{ index: 0, reason: 'those lines are not in the document — copy them exactly as they appear', search: '  const JUMP = 99;' }],
    ['an edit block had an empty SEARCH section']
  );
  assert.match(text, /empty SEARCH/);
  assert.match(text, /not in the document/);
  assert.match(text, /const JUMP = 99;/, 'the failed SEARCH is quoted back');
});

test('hunks are stored for the diff, unless they are big enough to threaten the document', () => {
  const small = [{ search: 'a', replace: 'b' }];
  assert.deepEqual(hunksForStorage(small), small);
  assert.deepEqual(hunksForStorage([]), []);
  assert.deepEqual(hunksForStorage(null), []);
  // A whole-document SEARCH would store the artifact a third time on one message.
  const huge = [{ search: 'x'.repeat(40_000), replace: 'y'.repeat(40_000) }];
  assert.deepEqual(hunksForStorage(huge), [], 'the diff is dropped, never the message');
  // Extra keys from applyPatch (like `strategy`) must not be persisted.
  assert.deepEqual(hunksForStorage([{ search: 'a', replace: 'b', strategy: 'exact' }]), [
    { search: 'a', replace: 'b' },
  ]);
});

test('a very long failed SEARCH is truncated in the repair prompt', () => {
  const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const text = describeFailures([{ index: 0, reason: 'nope', search: long }]);
  assert.equal(text.includes('line 5'), true);
  assert.equal(text.includes('line 30'), false, 'not the whole thing — this goes back to the model');
});
