/**
 * Unit tests for code-block text extraction.
 * Run: npm --prefix client test
 *
 * The load-bearing property: the text must come out of the *highlighted* tree,
 * not out of `String(children)`. Everything the code block shows and copies
 * hangs off this — the copy button, the line count, and the gutter that has to
 * line up with the code beside it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { codeText, countLines, gutterText } from './codeText.js';

/** Shaped like what react-markdown + rehype-highlight hand to the renderer. */
const span = (...children) => ({ type: 'span', props: { className: 'hljs-tag', children } });

test('plain string children come through unchanged', () => {
  assert.equal(codeText('const a = 1;\nconst b = 2;'), 'const a = 1;\nconst b = 2;');
});

test('highlighted tokens are read from the tree, not stringified', () => {
  // <span>const</span> " a = " <span>1</span> ";\n" ...
  const children = [span('const'), ' a = ', span('1'), ';\n', span('const'), ' b = 2;'];
  const text = codeText(children);
  assert.equal(text, 'const a = 1;\nconst b = 2;');
  assert.equal(text.includes('[object Object]'), false, 'no element was stringified');
});

test('nested spans are flattened (hljs nests tag inside attr inside tag)', () => {
  const children = [span('<', span('div'), ' ', span('class', '=', span('"x"')), '>')];
  assert.equal(codeText(children), '<div class="x">');
});

test('numbers, null, undefined and booleans are handled like React handles them', () => {
  assert.equal(codeText([1, null, undefined, false, '2']), '12');
  assert.equal(codeText(null), '');
  assert.equal(codeText(undefined), '');
});

test('an element with no children contributes nothing', () => {
  assert.equal(codeText({ type: 'br', props: {} }), '');
});

test('line counting ignores the trailing newline markdown appends', () => {
  assert.equal(countLines('a\nb\nc'), 3);
  assert.equal(countLines('a\nb\nc\n'), 3);
  assert.equal(countLines('one line'), 1);
  assert.equal(countLines(''), 0);
});

test('a 67-line block counts 67 lines through the highlighted tree', () => {
  // The real regression: 67 lines of HTML where every line sits inside a span,
  // so only the newlines *between* spans survive String(children) — 18 of them
  // in the case that surfaced this.
  const children = [];
  for (let i = 0; i < 67; i++) {
    children.push(span(`line ${i + 1}`));
    if (i < 66) children.push('\n');
  }
  assert.equal(countLines(codeText(children)), 67);
});

test('the gutter has exactly one number per line, newline-separated', () => {
  assert.equal(gutterText(3), '1\n2\n3');
  assert.equal(gutterText(1), '1');
  assert.equal(gutterText(0), '');
  const lines = gutterText(120).split('\n');
  assert.equal(lines.length, 120, 'one row per line, so the column stays aligned');
  assert.equal(lines[119], '120');
});
