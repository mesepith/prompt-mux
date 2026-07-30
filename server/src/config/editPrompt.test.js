/**
 * Unit tests for the point-and-edit sanitization layer.
 * Run: npm --prefix server test
 *
 * cleanFragment is the guard between "a model said something" and "we splice it
 * into the user's artifact", so its job is to recover the common sloppy shapes
 * (fences, a sentence of preamble) and to REFUSE the dangerous one: a whole
 * document, which would wipe out the surrounding code.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanFragment, rootTag, buildEditPrompt } from './editPrompt.js';
import { extractArtifacts, artifactFence, summarizeArtifactFences } from '../lib/artifacts.js';

const SNIPPET = '<h1 class="title">Old</h1>';

test('passes a clean fragment through untouched', () => {
  const out = cleanFragment('<h1 class="title">New</h1>', SNIPPET);
  assert.equal(out, '<h1 class="title">New</h1>');
});

test('unwraps a markdown code fence', () => {
  const out = cleanFragment('```html\n<h1 class="title">New</h1>\n```', SNIPPET);
  assert.equal(out, '<h1 class="title">New</h1>');
});

test('unwraps a fence with no language', () => {
  assert.equal(cleanFragment('```\n<h1>New</h1>\n```', SNIPPET), '<h1>New</h1>');
});

test('drops a sentence of preamble before the markup', () => {
  const out = cleanFragment('Sure! Here is the updated heading:\n<h1>New</h1>', SNIPPET);
  assert.equal(out, '<h1>New</h1>');
});

test('handles preamble AND a fence around the markup', () => {
  const out = cleanFragment('Sure! Here it is:\n```html\n<h1>New</h1>\n```', SNIPPET);
  assert.equal(out, '<h1>New</h1>');
});

test('drops trailing prose after the markup', () => {
  const out = cleanFragment('<h1>New</h1>\n\nLet me know if you want it bigger.', SNIPPET);
  assert.equal(out, '<h1>New</h1>');
});

test('keeps a multi-element fragment intact', () => {
  const frag = '<div class="row"><h1>New</h1><p>sub</p></div>';
  assert.equal(cleanFragment(frag, '<div class="row"><h1>Old</h1></div>'), frag);
});

test('keeps a <style> block inside the fragment', () => {
  const frag = '<h1 class="title">New</h1><style>.title{color:red}</style>';
  assert.equal(cleanFragment(frag, SNIPPET), frag);
});

test('rejects a full-document rewrite — the failure this feature exists to prevent', () => {
  assert.throws(
    () => cleanFragment('<!DOCTYPE html><html><body><h1>New</h1></body></html>', SNIPPET),
    /whole document/
  );
  assert.throws(() => cleanFragment('<html><body><h1>New</h1></body></html>', SNIPPET), /whole document/);
});

test('allows a document reply when the target itself was the document', () => {
  const docSnippet = '<html><body><h1>Old</h1></body></html>';
  const out = cleanFragment('<html><body><h1>New</h1></body></html>', docSnippet);
  assert.match(out, /^<html>/);
});

test('rejects empty and prose-only replies', () => {
  assert.throws(() => cleanFragment('   ', SNIPPET), /empty edit/);
  assert.throws(() => cleanFragment('I cannot do that.', SNIPPET), /prose instead of markup/);
});

test('rejects a fragment carrying a markdown fence that would corrupt the stored artifact', () => {
  const frag = '<pre><code>```js\nconst a = 1;\n```</code></pre>';
  assert.throws(() => cleanFragment(frag, '<pre><code>old</code></pre>'), /corrupt the artifact/);
});

test('rejects an implausibly large reply', () => {
  assert.throws(() => cleanFragment(`<h1>${'x'.repeat(400_001)}</h1>`, SNIPPET), /implausibly large/);
});

test('rootTag reports the outer element, or null for text', () => {
  assert.equal(rootTag('<h1 class="a">x</h1>'), 'h1');
  assert.equal(rootTag('  <SECTION>x</SECTION>'), 'section');
  assert.equal(rootTag('just text'), null);
});

test('buildEditPrompt carries document, target and instruction', () => {
  const code = '<div><h1>Old</h1></div>';
  const prompt = buildEditPrompt({
    code,
    start: 5,
    end: 18,
    snippet: '<h1>Old</h1>',
    instruction: 'make it blue',
    language: 'html',
    targetLabel: 'h1',
  });
  assert.match(prompt, /<div><h1>Old<\/h1><\/div>/);
  assert.match(prompt, /make it blue/);
  assert.match(prompt, /only the replacement markup/);
});

test('buildEditPrompt windows a huge document but keeps the head and target', () => {
  const head = '<!DOCTYPE html><head><style>.a{color:red}</style></head><body>';
  const filler = '<p>filler</p>'.repeat(6000); // ~78k chars
  const target = '<h1 id="needle">Old</h1>';
  const code = `${head}${filler}${target}${filler}</body>`;
  const start = code.indexOf(target);
  const prompt = buildEditPrompt({
    code,
    start,
    end: start + target.length,
    snippet: target,
    instruction: 'rename it',
    language: 'html',
    targetLabel: 'h1#needle',
  });
  assert.ok(prompt.length < code.length, 'prompt is smaller than the document');
  assert.match(prompt, /\.a\{color:red\}/, 'keeps the stylesheet at the top');
  assert.match(prompt, /needle/, 'keeps the target in context');
  assert.match(prompt, /document trimmed/);
});

test('extractArtifacts mirrors the client: html/svg fences, trivial ones ignored', () => {
  const content = [
    'Here you go:',
    '```html',
    '<div class="card">a reasonably long fragment of html here</div>',
    '```',
    'and a vector:',
    '```svg',
    '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>',
    '```',
    '```html',
    '<b>tiny</b>',
    '```',
    '```python',
    'print("not an artifact")',
    '```',
  ].join('\n');
  const artifacts = extractArtifacts(content);
  assert.equal(artifacts.length, 2);
  assert.deepEqual(artifacts.map((a) => a.language), ['html', 'svg']);
  assert.deepEqual(artifacts.map((a) => a.index), [0, 1]);
});

test('extractArtifacts tolerates an unterminated fence (interrupted stream)', () => {
  const artifacts = extractArtifacts('```html\n<div class="x">a long enough fragment of markup</div>');
  assert.equal(artifacts.length, 1);
  assert.match(artifacts[0].code, /^<div class="x">/);
});

test('artifactFence round-trips through extractArtifacts', () => {
  const code = '<div class="card">round trip me, with enough characters</div>';
  const [artifact] = extractArtifacts(`Updated \`h1\`.\n\n${artifactFence('html', code)}`);
  assert.equal(artifact.code, code);
});

test('summarizeArtifactFences strips code but keeps the prose', () => {
  const code = '<div>a fairly long artifact body that should be summarized away</div>';
  const summarized = summarizeArtifactFences(`Updated \`h1\`.\n\n${artifactFence('html', code)}`);
  assert.match(summarized, /^Updated `h1`\./);
  assert.equal(summarized.includes('<div>'), false);
  assert.match(summarized, /html artifact, \d+ chars — superseded/);
});
