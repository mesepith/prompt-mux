/**
 * Unit tests for the pricing-page HTML -> text extractor.
 * Run: npm --prefix server test
 *
 * The price proposals an admin reviews are only as good as this text, and the
 * failure that matters is silent: a row that splits across lines, or a cell that
 * vanishes, makes a model attribute an input price to the wrong model or the
 * wrong column. So the table assertions here are exact, not "contains".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, htmlTitle, decodeEntities } from './htmlText.js';

// Shaped like a real provider pricing page: head noise, nav/footer chrome, a
// table whose cells wrap their text in divs/spans, and entities in the numbers.
const PRICING_PAGE = `<!DOCTYPE html>
<html><head><title>OpenAI &mdash; API Pricing</title>
<style>.price td { color: red }</style></head>
<body>
<script>var rows = [{ html: "<td>bogus</td>" }];</script>
<nav><a href="/docs">Docs</a><a href="/pricing">Pricing</a></nav>
<!-- editors note: <td>hidden</td> -->
<h1>Pricing</h1>
<table class="price">
  <thead><tr><th>Model</th><th>Input</th><th>Cached input</th><th>Output</th></tr></thead>
  <tbody>
    <tr>
      <td><div class="cell"><span>gpt</span>-4.1</div></td>
      <td>&dollar;2.00</td><td>$0.50</td><td>$8.00</td>
    </tr>
    <tr><td>gpt-4.1&nbsp;mini</td><td>$0.40</td><td>$0.10</td><td>$1.60</td></tr>
    <tr><td>o3-pro</td><td>$20.00</td><td></td><td>$80.00</td></tr>
  </tbody>
</table>
<p>Prices are per 1M&#160;tokens.<br>Updated&hellip;</p>
<footer>&copy; 2026 OpenAI</footer>
</body></html>`;

test('a pricing table comes out as one pipe-separated line per row', () => {
  const { text } = htmlToText(PRICING_PAGE);
  const lines = text.split('\n');
  assert.deepEqual(lines, [
    'Pricing',
    'Model | Input | Cached input | Output',
    'gpt-4.1 | $2.00 | $0.50 | $8.00',
    'gpt-4.1 mini | $0.40 | $0.10 | $1.60',
    'o3-pro | $20.00 |  | $80.00',
    'Prices are per 1M tokens.',
    'Updated…',
  ]);
});

test('a blank cell keeps its column, so prices stay under their header', () => {
  const { text } = htmlToText('<table><tr><td>o3-pro</td><td></td><td>$80.00</td></tr></table>');
  assert.equal(text, 'o3-pro |  | $80.00');
  const cells = text.split(' | ');
  assert.equal(cells.length, 3);
  assert.equal(cells[2], '$80.00', 'the price is still the third column');
});

test('cells still separate when the closing tags are omitted', () => {
  const { text } = htmlToText('<table><tr><td>Sonnet<td>$3.00<td>$15.00</table>');
  assert.equal(text, 'Sonnet | $3.00 | $15.00');
});

test('markup inside a cell does not break the row apart', () => {
  const { text } = htmlToText(
    '<table><tr><td><div><p>Claude Opus</p></div></td><td><span>$</span><span>15.00</span></td></tr></table>'
  );
  assert.equal(text, 'Claude Opus | $15.00', 'inline tags glue, block tags fold back onto the row');
});

test('script, style and other chrome are dropped with their contents', () => {
  const { text } = htmlToText(PRICING_PAGE);
  for (const leak of ['bogus', 'color: red', 'hidden', 'Docs', '2026 OpenAI', 'var rows']) {
    assert.equal(text.includes(leak), false, `${leak} should not survive`);
  }
});

test('block elements and <br> each end the line', () => {
  const { text } = htmlToText(
    '<div>Header</div><p>One<br>Two</p><ul><li>a</li><li>b</li></ul><h2>Next</h2>'
  );
  assert.deepEqual(text.split('\n'), ['Header', 'One', 'Two', 'a', 'b', 'Next']);
});

test('inline tags add no whitespace of their own', () => {
  const { text } = htmlToText('<p><b>$2</b><i>.00</i> per <em>1M</em></p>');
  assert.equal(text, '$2.00 per 1M');
});

test('whitespace is normalized: no blank lines, no runs of spaces', () => {
  const { text } = htmlToText(
    '<div>\n\n  a \t\t b  \n</div>\n<div></div>\n<div>   </div>\n<div>c</div>'
  );
  assert.equal(text, 'a b\nc');
  assert.equal(/\n\s*\n/.test(text), false, 'no empty lines');
  assert.equal(/ {2}/.test(text.replaceAll(' |  | ', '')), false, 'no double spaces');
});

test('entities decode, including &nbsp; and numeric forms', () => {
  assert.equal(decodeEntities('a &amp; b'), 'a & b');
  assert.equal(decodeEntities('&lt;td&gt;'), '<td>');
  assert.equal(decodeEntities('&quot;x&quot; &apos;y&apos;'), '"x" \'y\'');
  assert.equal(decodeEntities('1M&nbsp;tokens'), '1M tokens', '&nbsp; is a normal space');
  assert.equal(decodeEntities("it&#39;s it&#x27;s"), "it's it's");
  assert.equal(decodeEntities('&mdash;&ndash;&times;&rarr;&hellip;'), '—–×→…');
  assert.equal(decodeEntities('&dollar;1 &euro;2 &pound;3'), '$1 €2 £3');
  assert.equal(decodeEntities('&#8212; &#x2014; &#960;'), '— — π');
  assert.equal(decodeEntities('&notanentity; &amp'), '&notanentity; &amp', 'unknown text is left alone');
  assert.equal(decodeEntities('&amp;lt;'), '&lt;', 'single pass: no double decoding');
  assert.equal(decodeEntities(null), '');
});

test('a real non-breaking space in the markup becomes an ordinary space', () => {
  const { text } = htmlToText('<p>$2.00\xa0/\xa01M tokens</p>');
  assert.equal(text, '$2.00 / 1M tokens');
});

test('truncation reports the full size and cuts on a line boundary', () => {
  const rows = Array.from(
    { length: 200 },
    (_, i) => `<tr><td>model-${i}</td><td>$${i}.00</td><td>$${i * 4}.00</td></tr>`
  ).join('');
  const html = `<table>${rows}</table>`;

  const whole = htmlToText(html);
  assert.equal(whole.truncated, false);
  assert.equal(whole.chars, whole.text.length);

  const cut = htmlToText(html, { maxChars: 500 });
  assert.equal(cut.truncated, true);
  assert.equal(cut.chars, whole.chars, 'chars is the full length, not the kept length');
  assert.ok(cut.text.length <= 500);
  assert.ok(whole.text.startsWith(cut.text), 'the kept part is a prefix of the whole');
  assert.equal(whole.text[cut.text.length], '\n', 'the cut landed on a line boundary');
  assert.equal(cut.text.endsWith('.00'), true, 'so the last row is complete');
});

test('a first line longer than the budget is cut hard rather than lost', () => {
  const { text, chars, truncated } = htmlToText('<p>one very long single line here</p>', {
    maxChars: 8,
  });
  assert.equal(truncated, true);
  assert.equal(chars, 30);
  assert.equal(text, 'one very');
});

test('htmlTitle decodes, strips tags and reports null when there is none', () => {
  assert.equal(htmlTitle(PRICING_PAGE), 'OpenAI — API Pricing');
  assert.equal(htmlTitle('<title data-x="1">\n  Anthropic\n  Pricing  </title>'), 'Anthropic Pricing');
  assert.equal(htmlTitle('<TITLE>Mistral &amp; friends</TITLE>'), 'Mistral & friends');
  assert.equal(htmlTitle('<title><span>Google</span> AI</title>'), 'Google AI');
  assert.equal(htmlTitle('<title>   </title>'), null);
  assert.equal(htmlTitle('<html><body>no title</body></html>'), null);
  assert.equal(htmlTitle(null), null);
});

test('non-string input yields an empty result instead of throwing', () => {
  assert.deepEqual(htmlToText(undefined), { text: '', chars: 0, truncated: false });
  assert.deepEqual(htmlToText(''), { text: '', chars: 0, truncated: false });
});

test('a megabyte of markup extracts in linear time, not exponential', () => {
  const row = '<tr><td>a model with a fairly long name</td><td>$1.00</td><td>$4.00</td></tr>\n';
  const html = `<html><body><table>${row.repeat(12000)}</table>` +
    `<div>${'lots   of \t padded   words '.repeat(12000)}</div></body></html>`;
  assert.ok(html.length > 1_000_000);

  const started = Date.now();
  const { text, chars, truncated } = htmlToText(html, { maxChars: 2000 });
  assert.ok(Date.now() - started < 5000, 'no catastrophic backtracking');
  assert.equal(truncated, true);
  assert.ok(chars > 500_000);
  assert.equal(text.split('\n')[0], 'a model with a fairly long name | $1.00 | $4.00');
});
