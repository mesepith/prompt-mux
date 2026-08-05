/**
 * Unit tests for artifact preview documents.
 * Run: npm --prefix client test
 *
 * The load-bearing property: every shape of artifact ends up with the
 * no-network CSP in its (possibly implied) head, BEFORE any of the model's own
 * markup — a meta CSP placed after content, or outside the head, is ignored, and
 * then artifact JS can beacon the user's chats out again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPreviewDoc,
  extractArtifacts,
  openArtifactInNewTab,
  openPendingTab,
  settlePendingTab,
} from './artifacts.js';

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
  assert.equal(/connect-src|img-src[^;]*https/.test(doc), false, `${label}: nothing re-opens the network`);
};

test('a bare fragment artifact is wrapped with the CSP', () => {
  const doc = buildPreviewDoc({ language: 'html', code: '<div class="card">hello there, a fragment</div>' });
  assertLockedDown(doc, 'fragment');
  assert.match(doc, /<div class="card">/);
});

test('an svg artifact is wrapped with the CSP', () => {
  const doc = buildPreviewDoc({ language: 'svg', code: '<svg viewBox="0 0 10 10"><circle r="4"/></svg>' });
  assertLockedDown(doc, 'svg');
  assert.match(doc, /<circle r="4"\/>/);
});

test('a full document gets the CSP as the first thing in its existing head', () => {
  const code = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>App</title>\n</head>\n<body><h1>Hi</h1></body></html>';
  const doc = buildPreviewDoc({ language: 'html', code });
  assertLockedDown(doc, 'full document');
  assert.ok(cspAt(doc) < doc.indexOf('<meta charset'), 'CSP comes before the document\'s own head content');
});

test('a document with no <head> gets one', () => {
  const code = '<!DOCTYPE html><html><body><h1>No head here at all</h1></body></html>';
  const doc = buildPreviewDoc({ language: 'html', code });
  assertLockedDown(doc, 'no head');
  assert.match(doc, /<html><head><meta http-equiv/);
});

test('a document with neither <html> nor <head> still gets the CSP first', () => {
  const code = '<!DOCTYPE html><body><h1>Straight to the body, no head</h1></body>';
  const doc = buildPreviewDoc({ language: 'html', code });
  assertLockedDown(doc, 'doctype only');
  assert.ok(cspAt(doc) < bodyAt(doc));
});

test('a stray "head" mentioned after the body does not misplace the CSP', () => {
  const code = '<!DOCTYPE html><html><body><p>call it a head start</p><script>var head = 1;</script></body></html>';
  const doc = buildPreviewDoc({ language: 'html', code });
  assertLockedDown(doc, 'head-shaped text in body');
});

test('picker mode keeps the CSP and adds the runtime inside the body', () => {
  const code = '<!DOCTYPE html><html><head><title>T</title></head><body><h1>Pick me</h1></body></html>';
  const doc = buildPreviewDoc({ language: 'html', code }, { picker: true });
  assertLockedDown(doc, 'picker');
  assert.match(doc, /data-pm-node="/, 'elements are stamped');
  assert.match(doc, /__PROMPTMUX_PICKER__/, 'runtime injected');
  assert.ok(doc.indexOf('__PROMPTMUX_PICKER__') < doc.indexOf('</body>'), 'runtime runs inside the body');
  // The CSP must allow the injected inline script, or point-and-edit breaks.
  assert.match(doc, /script-src 'unsafe-inline'/);
  assert.match(doc, /style-src 'unsafe-inline'/);
});

test('the preview copy never leaks stamped ids back into the stored code', () => {
  const code = '<div class="wrap"><h1>Title</h1><p>Body copy goes here</p></div>';
  const artifact = { language: 'html', code };
  buildPreviewDoc(artifact, { picker: true });
  assert.equal(artifact.code, code, 'the artifact object is untouched');
  assert.equal(extractArtifacts('```html\n' + code + '\n```')[0].code, code);
});

test('no artifact means no document', () => {
  assert.equal(buildPreviewDoc(null), '');
});

// --- "open in new tab": must land in a sandboxed frame, never a same-origin
// blob: document, or the model's JS runs with access to the user's chats.
function openInStubbedTab(artifact) {
  let written = '';
  const previous = globalThis.window;
  globalThis.window = {
    open: () => ({ document: { write: (html) => { written += html; }, close: () => {} } }),
  };
  try {
    const opened = openArtifactInNewTab(artifact);
    return { opened, written };
  } finally {
    globalThis.window = previous;
  }
}

const unescapeAttr = (value) =>
  value.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

test('the new tab hosts the artifact in a sandboxed frame, not a same-origin document', () => {
  const { opened, written } = openInStubbedTab({
    language: 'html',
    code: '<div class="card">a perfectly ordinary artifact body</div>',
    title: 'My App',
  });
  assert.equal(opened, true);
  assert.match(written, /<iframe sandbox="allow-scripts" srcdoc="/);
  assert.equal(/URL\.createObjectURL|src="blob:/.test(written), false, 'no blob: URL document');
  assert.match(unescapeAttr(written.match(/srcdoc="([^"]*)"/)[1]), /Content-Security-Policy/);
});

test('a hostile artifact cannot break out of the srcdoc attribute or the title', () => {
  const nasty = [
    '<div class="x" onclick="alert(1)">',
    '"><script>parent.location="http://evil.example"</script>',
    '</iframe><script>fetch("/api/conversations")</script>',
    '&quot;&amp;<img src=x onerror=alert(1)>',
    '</div>',
  ].join('');
  const { written } = openInStubbedTab({ language: 'html', code: nasty, title: '"><script>alert(1)</script>' });

  // Exactly one iframe and one quoted srcdoc: nothing escaped the attribute.
  assert.equal(written.match(/<iframe/g).length, 1);
  const srcdoc = written.match(/srcdoc="([^"]*)"/);
  assert.ok(srcdoc, 'srcdoc is a single quoted attribute');
  // Everything the model wrote survives inside it, escaped — and only there.
  const inner = unescapeAttr(srcdoc[1]);
  assert.ok(inner.includes('onerror=alert(1)'), 'the payload is preserved as data');
  const wrapperOnly = written.replace(srcdoc[0], 'srcdoc="…"');
  assert.equal(/<script/i.test(wrapperOnly), false, 'no executable script reached the wrapper page');
  // The title keeps the text but only as escaped, inert characters.
  assert.match(wrapperOnly, /<title>&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/title>/);
});

test('a blocked popup is reported instead of silently doing nothing', () => {
  const previous = globalThis.window;
  globalThis.window = { open: () => null };
  try {
    assert.equal(openArtifactInNewTab({ language: 'html', code: '<p>blocked popup case here</p>' }), false);
  } finally {
    globalThis.window = previous;
  }
});

// --- the published-link path: claim the tab during the click, navigate after
// the server answers. A placeholder tab left behind is worse than none.
function withStubbedWindow(open, fn) {
  const previous = globalThis.window;
  globalThis.window = { open };
  try {
    return fn();
  } finally {
    globalThis.window = previous;
  }
}

const stubTab = () => {
  const tab = {
    written: '',
    closed: false,
    replaced: null,
    document: { write: (html) => { tab.written += html; }, close: () => {} },
    location: { replace: (url) => { tab.replaced = url; } },
    close: () => { tab.closed = true; },
  };
  return tab;
};

test('the pending tab shows a placeholder and nothing executable', () => {
  const tab = stubTab();
  const opened = withStubbedWindow(() => tab, () => openPendingTab());
  assert.equal(opened, tab);
  assert.match(tab.written, /Preparing your artifact link/);
  assert.equal(/<script/i.test(tab.written), false);
});

test('a hostile label cannot inject markup into the placeholder', () => {
  const tab = stubTab();
  withStubbedWindow(() => tab, () => openPendingTab('</style><script>alert(1)</script>'));
  assert.equal(/<script/i.test(tab.written), false, 'the label stays inert text');
  assert.match(tab.written, /&lt;script&gt;/);
});

test('settling sends the tab to the link, or closes it when there is none', () => {
  const ok = stubTab();
  assert.equal(settlePendingTab(ok, 'https://example.test/a/abc'), true);
  assert.equal(ok.replaced, 'https://example.test/a/abc');
  assert.equal(ok.closed, false);

  const failed = stubTab();
  assert.equal(settlePendingTab(failed, null), false);
  assert.equal(failed.closed, true);
  assert.equal(failed.replaced, null);
});

test('a blocked pending tab is reported so the caller can offer the link instead', () => {
  assert.equal(withStubbedWindow(() => null, () => openPendingTab()), null);
  assert.equal(settlePendingTab(null, 'https://example.test/a/abc'), false);
});
