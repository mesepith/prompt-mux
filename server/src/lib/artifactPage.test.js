/**
 * Unit tests for the published artifact page (/a/<publicId>).
 * Run: npm --prefix server test
 *
 * This page is the only place model-written HTML is served as a top-level
 * document from this app's own origin, so both defences are asserted here:
 * the artifact reaches the browser ONLY inside a quoted srcdoc on an
 * `allow-scripts` (never `allow-same-origin`) frame, and every document shape
 * carries the no-network CSP first inside its head. Mirrors
 * client/src/lib/artifacts.test.js — the two must not drift.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArtifactDoc, renderArtifactPage, renderMissingPage } from './artifactPage.js';

const cspAt = (doc) => doc.indexOf('Content-Security-Policy');
const headAt = (doc) => doc.search(/<head[\s>]/i);
const bodyAt = (doc) => doc.search(/<body[\s>]/i);

const assertLockedDown = (doc, label) => {
  assert.ok(cspAt(doc) !== -1, `${label}: has a CSP`);
  assert.ok(cspAt(doc) < bodyAt(doc) || bodyAt(doc) === -1, `${label}: CSP precedes the body`);
  assert.ok(headAt(doc) === -1 || headAt(doc) < cspAt(doc), `${label}: CSP sits inside the head`);
  assert.match(doc, /default-src 'none'/, `${label}: no network by default`);
  assert.match(doc, /img-src data: blob:/, `${label}: no remote image beacons`);
  assert.match(doc, /form-action 'none'/, `${label}: no form exfiltration`);
  assert.equal(
    /connect-src|img-src[^;]*https/.test(doc),
    false,
    `${label}: nothing re-opens the network`
  );
};

test('a bare fragment is wrapped with the CSP', () => {
  const doc = buildArtifactDoc({
    language: 'html',
    code: '<div class="card">hello there, a fragment</div>',
  });
  assertLockedDown(doc, 'fragment');
  assert.match(doc, /<div class="card">/);
});

test('an svg artifact is wrapped with the CSP', () => {
  const doc = buildArtifactDoc({
    language: 'svg',
    code: '<svg viewBox="0 0 10 10"><circle r="4"/></svg>',
  });
  assertLockedDown(doc, 'svg');
  assert.match(doc, /<circle r="4"\/>/);
});

test('a full document gets the CSP as the first thing in its existing head', () => {
  const code =
    '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>App</title>\n</head>\n<body><h1>Hi</h1></body></html>';
  const doc = buildArtifactDoc({ language: 'html', code });
  assertLockedDown(doc, 'full document');
  assert.ok(cspAt(doc) < doc.indexOf('<meta charset'), 'CSP comes before the head content');
});

test('a document with no <head> gets one', () => {
  const doc = buildArtifactDoc({
    language: 'html',
    code: '<!DOCTYPE html><html><body><h1>No head here at all</h1></body></html>',
  });
  assertLockedDown(doc, 'no head');
  assert.match(doc, /<html><head><meta http-equiv/);
});

test('a document with neither <html> nor <head> still gets the CSP first', () => {
  const doc = buildArtifactDoc({
    language: 'html',
    code: '<!DOCTYPE html><body><h1>Straight to the body, no head</h1></body>',
  });
  assertLockedDown(doc, 'doctype only');
  assert.ok(cspAt(doc) < bodyAt(doc));
});

test('a stray "head" mentioned after the body does not misplace the CSP', () => {
  const doc = buildArtifactDoc({
    language: 'html',
    code: '<!DOCTYPE html><html><body><p>call it a head start</p><script>var head = 1;</script></body></html>',
  });
  assertLockedDown(doc, 'head-shaped text in body');
});

test('no code means no document', () => {
  assert.equal(buildArtifactDoc(null), '');
  assert.equal(buildArtifactDoc({ language: 'html', code: '' }), '');
});

// --- the page itself ---

const unescapeAttr = (value) =>
  value.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

test('the page hosts the artifact in a sandboxed frame, never as the page itself', () => {
  const page = renderArtifactPage({
    language: 'html',
    code: '<div class="card">a perfectly ordinary artifact body</div>',
    title: 'My App',
  });
  assert.match(page, /<iframe title="My App" sandbox="allow-scripts" srcdoc="/);
  assert.equal(/allow-same-origin/.test(page), false, 'the frame stays opaque-origin');
  assert.equal(/src="blob:|createObjectURL/.test(page), false, 'no blob: URL document');
  assert.match(unescapeAttr(page.match(/srcdoc="([^"]*)"/)[1]), /Content-Security-Policy/);
});

test('a hostile artifact cannot break out of the srcdoc attribute or the title', () => {
  const nasty = [
    '<div class="x" onclick="alert(1)">',
    '"><script>parent.location="http://evil.example"</script>',
    '</iframe><script>fetch("/api/conversations")</script>',
    '&quot;&amp;<img src=x onerror=alert(1)>',
    '</div>',
  ].join('');
  const page = renderArtifactPage({
    language: 'html',
    code: nasty,
    title: '"><script>alert(1)</script>',
  });

  // Exactly one iframe and one quoted srcdoc: nothing escaped the attribute.
  assert.equal(page.match(/<iframe/g).length, 1);
  const srcdoc = page.match(/srcdoc="([^"]*)"/);
  assert.ok(srcdoc, 'srcdoc is a single quoted attribute');
  const inner = unescapeAttr(srcdoc[1]);
  assert.ok(inner.includes('onerror=alert(1)'), 'the payload is preserved as data');
  const wrapperOnly = page.replace(srcdoc[0], 'srcdoc="…"');
  assert.equal(/<script/i.test(wrapperOnly), false, 'no executable script reached the wrapper');
  assert.match(
    wrapperOnly,
    /<title>&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/title>/,
    'the title is inert text'
  );
});

test('the wrapper page ships none of the app', () => {
  const page = renderArtifactPage({ language: 'html', code: '<p>just an artifact here</p>' });
  assert.equal(/<script/i.test(page), false, 'no script of ours on the page');
  assert.equal(/\/api\//.test(page), false, 'nothing points at the API');
});

test('a missing artifact renders one page for wrong, deleted and private alike', () => {
  const page = renderMissingPage();
  assert.match(page, /isn't available/);
  // It must not hint at which of the three it was.
  assert.equal(/deleted only|exists|owner is/i.test(page), false);
  assert.equal(/<script/i.test(page), false);
});
