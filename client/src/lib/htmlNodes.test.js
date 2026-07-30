/**
 * Unit tests for the point-and-edit source scanner.
 * Run: npm --prefix client test    (node --test, no test framework needed)
 *
 * The invariant under test everywhere: for every node, code.slice(start, end)
 * must be exactly that element's own markup — never a sibling's, never short.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanHtmlNodes, annotateHtml, replaceRange } from './htmlNodes.js';

const slice = (code, node) => code.slice(node.start, node.end);
const byTag = (nodes, tag) => nodes.filter((n) => n.tag === tag);
const find = (nodes, label) => nodes.find((n) => n.label === label);

test('brackets a simple element exactly', () => {
  const code = '<div class="a">hello</div>';
  const [node] = scanHtmlNodes(code);
  assert.equal(node.tag, 'div');
  assert.equal(slice(code, node), code);
  assert.equal(node.label, 'div.a');
});

test('nests children and keeps sibling ranges disjoint', () => {
  const code = '<ul><li>one</li><li>two</li></ul>';
  const nodes = scanHtmlNodes(code);
  const [ul, li1, li2] = nodes;
  assert.equal(slice(code, ul), code);
  assert.equal(slice(code, li1), '<li>one</li>');
  assert.equal(slice(code, li2), '<li>two</li>');
  assert.equal(li1.parent, ul.id);
  assert.equal(li2.depth, 1);
});

test('handles ">" inside quoted attribute values', () => {
  const code = '<a href="/x?a=1&b=2" title="a > b">link</a><p>after</p>';
  const nodes = scanHtmlNodes(code);
  assert.equal(slice(code, nodes[0]), '<a href="/x?a=1&b=2" title="a > b">link</a>');
  assert.equal(slice(code, nodes[1]), '<p>after</p>');
});

test('handles single-quoted attributes and unquoted values', () => {
  const code = "<div id='hero' data-x=1><span class=big>hi</span></div>";
  const nodes = scanHtmlNodes(code);
  assert.equal(nodes[0].label, 'div#hero');
  assert.equal(nodes[1].label, 'span.big');
  assert.equal(slice(code, nodes[1]), '<span class=big>hi</span>');
});

test('skips comments, doctype and stray "<" in text', () => {
  const code = '<!DOCTYPE html><!-- <div>not real</div> --><p>5 < 6</p>';
  const nodes = scanHtmlNodes(code);
  assert.equal(nodes.length, 1);
  assert.equal(slice(code, nodes[0]), '<p>5 < 6</p>');
});

test('treats script/style/textarea as raw text', () => {
  const code = '<style>a { content: "</div>" }</style><script>if (1<2) { x = "</p>"; }</script><b>real</b>';
  const nodes = scanHtmlNodes(code);
  assert.deepEqual(nodes.map((n) => n.tag), ['style', 'script', 'b']);
  assert.equal(slice(code, nodes[0]), '<style>a { content: "</div>" }</style>');
  assert.equal(slice(code, nodes[1]), '<script>if (1<2) { x = "</p>"; }</script>');
  assert.equal(slice(code, nodes[2]), '<b>real</b>');
  assert.equal(nodes[0].pickable, false);
  assert.equal(nodes[1].pickable, false);
});

test('void elements end at their own ">"', () => {
  const code = '<div><img src="a.png"><br><input type="text" value="x"></div>';
  const nodes = scanHtmlNodes(code);
  assert.equal(slice(code, nodes[0]), code);
  assert.equal(slice(code, byTag(nodes, 'img')[0]), '<img src="a.png">');
  assert.equal(slice(code, byTag(nodes, 'input')[0]), '<input type="text" value="x">');
});

test('void elements written XHTML-style still end at ">"', () => {
  const code = '<p><img src="a.png" /><span>t</span></p>';
  const nodes = scanHtmlNodes(code);
  assert.equal(slice(code, byTag(nodes, 'img')[0]), '<img src="a.png" />');
  assert.equal(slice(code, byTag(nodes, 'span')[0]), '<span>t</span>');
});

test('implicitly closes <li> at the next <li>', () => {
  const code = '<ul><li>one<li>two</ul>';
  const nodes = scanHtmlNodes(code);
  const [, li1, li2] = nodes;
  assert.equal(slice(code, li1), '<li>one');
  assert.equal(slice(code, li2), '<li>two');
  assert.equal(li2.depth, 1, 'the second <li> is a sibling, not a child');
});

test('implicitly closes <p> at a block-level start', () => {
  const code = '<p>one<p>two<div>three</div>';
  const nodes = scanHtmlNodes(code);
  assert.equal(slice(code, nodes[0]), '<p>one');
  assert.equal(slice(code, nodes[1]), '<p>two');
  assert.equal(slice(code, nodes[2]), '<div>three</div>');
  assert.equal(nodes[2].depth, 0);
});

test('implicitly closes table cells and rows', () => {
  const code = '<table><tr><td>a<td>b<tr><td>c</table>';
  const nodes = scanHtmlNodes(code);
  const tds = byTag(nodes, 'td');
  const trs = byTag(nodes, 'tr');
  assert.equal(slice(code, tds[0]), '<td>a');
  assert.equal(slice(code, tds[1]), '<td>b');
  assert.equal(slice(code, trs[0]), '<tr><td>a<td>b');
  assert.equal(slice(code, trs[1]), '<tr><td>c');
});

test('pops through mismatched close tags without swallowing siblings', () => {
  const code = '<div><span>lost</div><p>after</p>';
  const nodes = scanHtmlNodes(code);
  const span = byTag(nodes, 'span')[0];
  const div = byTag(nodes, 'div')[0];
  assert.equal(slice(code, span), '<span>lost', 'span ends where </div> starts');
  assert.equal(slice(code, div), '<div><span>lost</div>');
  assert.equal(slice(code, byTag(nodes, 'p')[0]), '<p>after</p>');
});

test('ignores a close tag with no matching open element', () => {
  const code = '</div><p>ok</p>';
  const nodes = scanHtmlNodes(code);
  assert.equal(nodes.length, 1);
  assert.equal(slice(code, nodes[0]), '<p>ok</p>');
});

test('unclosed elements run to end of source', () => {
  const code = '<div><section>text';
  const nodes = scanHtmlNodes(code);
  assert.equal(slice(code, nodes[0]), code);
  assert.equal(slice(code, nodes[1]), '<section>text');
});

test('svg children self-close inside foreign content', () => {
  const code = '<svg viewBox="0 0 10 10"><path d="M0 0 L10 10"/><circle cx="5" cy="5" r="2"/></svg><p>next</p>';
  const nodes = scanHtmlNodes(code);
  assert.equal(slice(code, byTag(nodes, 'path')[0]), '<path d="M0 0 L10 10"/>');
  assert.equal(slice(code, byTag(nodes, 'circle')[0]), '<circle cx="5" cy="5" r="2"/>');
  assert.equal(slice(code, byTag(nodes, 'svg')[0]), code.slice(0, code.indexOf('<p>')));
  assert.equal(slice(code, byTag(nodes, 'p')[0]), '<p>next</p>');
});

test('a self-closing HTML div stays open, matching browser parsing', () => {
  const code = '<div class="wrap"/><span>inside</span>';
  const nodes = scanHtmlNodes(code);
  // Per spec the slash is ignored, so <span> is a child and the div runs to EOF.
  assert.equal(slice(code, nodes[0]), code);
  assert.equal(nodes[1].depth, 1);
});

test('scans a full document and picks out body content', () => {
  const code = [
    '<!DOCTYPE html>',
    '<html lang="en"><head><meta charset="utf-8"><title>T</title></head>',
    '<body><h1 id="t">Hi</h1><button class="cta primary">Go</button></body></html>',
  ].join('\n');
  const nodes = scanHtmlNodes(code);
  const button = find(nodes, 'button.cta.primary');
  assert.ok(button, 'label carries id/class');
  assert.equal(slice(code, button), '<button class="cta primary">Go</button>');
  assert.equal(find(nodes, 'h1#t').pickable, true);
  assert.equal(byTag(nodes, 'html')[0].pickable, false);
  assert.equal(byTag(nodes, 'head')[0].pickable, false);
  assert.equal(byTag(nodes, 'body')[0].pickable, true, 'body is a valid page-level target');
});

test('annotateHtml stamps every pickable node and leaves the original intact', () => {
  const code = '<div class="a"><script>x=1</script><p>hi</p><img src="i.png"></div>';
  const annotated = annotateHtml(code);
  const nodes = scanHtmlNodes(code);
  for (const node of nodes) {
    const has = annotated.includes(`data-pm-node="${node.id}"`);
    assert.equal(has, node.pickable, `node ${node.tag} annotation`);
  }
  // Attributes are inserted right after the tag name, before existing attrs.
  assert.match(annotated, /<div data-pm-node="0" class="a">/);
  assert.match(annotated, /<img data-pm-node="\d+" src="i\.png">/);
  assert.equal(annotated.includes('<script data-pm-node'), false);
  // The scan is a pure read: offsets still describe the untouched source.
  assert.equal(scanHtmlNodes(code).length, nodes.length);
});

test('annotation survives round-tripping through a re-scan', () => {
  const code = '<section><h2>Title</h2><p>Body</p></section>';
  const annotated = annotateHtml(code);
  const rescanned = scanHtmlNodes(annotated);
  // Same element sequence, and each annotated node still brackets itself.
  assert.deepEqual(rescanned.map((n) => n.tag), scanHtmlNodes(code).map((n) => n.tag));
  const h2 = byTag(rescanned, 'h2')[0];
  assert.equal(annotated.slice(h2.start, h2.end), '<h2 data-pm-node="1">Title</h2>');
});

test('replaceRange splices only the selected element', () => {
  const code = '<div><h1>Old</h1><p>keep</p></div>';
  const h1 = byTag(scanHtmlNodes(code), 'h1')[0];
  const out = replaceRange(code, h1.start, h1.end, '<h1 class="new">New</h1>');
  assert.equal(out, '<div><h1 class="new">New</h1><p>keep</p></div>');
});

// --- optional end tags: the cases where a naive "only check the top of the stack"
// implementation gives an element a range that swallows its following siblings.
test('a second <li> closes both the open <p> and the first <li>', () => {
  const code = '<ul class="todo"><li><p>Buy milk<li><p>Walk dog<li><p>Ship it</ul>';
  const nodes = scanHtmlNodes(code);
  const lis = byTag(nodes, 'li');
  assert.deepEqual(lis.map((n) => slice(code, n)), ['<li><p>Buy milk', '<li><p>Walk dog', '<li><p>Ship it']);
  assert.deepEqual(lis.map((n) => n.depth), [1, 1, 1], 'siblings, not nested');
  assert.deepEqual(byTag(nodes, 'p').map((n) => slice(code, n)), ['<p>Buy milk', '<p>Walk dog', '<p>Ship it']);
});

test('the implied-end-tag walk steps through a <div> but stops at a nested list', () => {
  const viaDiv = '<ul><li><div>a<li><div>b</ul>';
  assert.deepEqual(byTag(scanHtmlNodes(viaDiv), 'li').map((n) => slice(viaDiv, n)), ['<li><div>a', '<li><div>b']);
  // A nested <ul> stops the walk — the inner <li> belongs to the inner list.
  const nested = '<ul><li>a<ul><li>b</ul></ul>';
  const nodes = scanHtmlNodes(nested);
  assert.equal(slice(nested, byTag(nodes, 'li')[0]), '<li>a<ul><li>b</ul>');
  assert.equal(byTag(nodes, 'li')[1].depth, 3);
});

test('a table section closes an open <caption> or <colgroup>', () => {
  const cap = '<table><caption>Quarterly sales<tbody><tr><td>EMEA</td></tr></tbody></table>';
  const capNodes = scanHtmlNodes(cap);
  assert.equal(slice(cap, byTag(capNodes, 'caption')[0]), '<caption>Quarterly sales');
  assert.equal(byTag(capNodes, 'tbody')[0].depth, 1, 'tbody is a sibling of caption');
  const col = '<table><colgroup><col><col><thead><tr><th>h</thead><tbody><tr><td>1<td>2</table>';
  const colNodes = scanHtmlNodes(col);
  assert.equal(slice(col, byTag(colNodes, 'colgroup')[0]), '<colgroup><col><col>');
  assert.equal(byTag(colNodes, 'thead')[0].depth, 1);
});

test('a nested table keeps its own cells — the walk must not reach the outer row', () => {
  const code = '<table><tr><td>outer<table><tr><td>inner</table></table>';
  const nodes = scanHtmlNodes(code);
  const tds = byTag(nodes, 'td');
  assert.equal(slice(code, tds[1]), '<td>inner');
  assert.equal(tds[1].parent, byTag(nodes, 'tr')[1].id);
});

test('<dialog> and <summary> close an open <p>', () => {
  const code = '<div><p>Intro text<dialog open>Modal</dialog></div>';
  const nodes = scanHtmlNodes(code);
  assert.equal(slice(code, byTag(nodes, 'p')[0]), '<p>Intro text');
  assert.equal(byTag(nodes, 'dialog')[0].depth, 1);
});

test('dt/dd and optgroup/option chains stay flat', () => {
  const dl = '<dl><dt>t<dd><p>d<dt>t2<dd><p>d2</dl>';
  const dlNodes = scanHtmlNodes(dl);
  assert.deepEqual(byTag(dlNodes, 'dt').map((n) => slice(dl, n)), ['<dt>t', '<dt>t2']);
  assert.deepEqual(byTag(dlNodes, 'dd').map((n) => slice(dl, n)), ['<dd><p>d', '<dd><p>d2']);
  const sel = '<select><optgroup label="a"><option>1<option>2<optgroup label="b"><option>3</select>';
  const selNodes = scanHtmlNodes(sel);
  assert.deepEqual(byTag(selNodes, 'optgroup').map((n) => n.depth), [1, 1]);
});

// --- attribute scanning: a quote only delimits a value when it follows "="
test('an escaped quote inside an event handler does not desync the scan', () => {
  const code = `<body><h1>R</h1><button class="cta" onclick='save("It\\'s done")'>Save</button><p>after</p></body>`;
  const nodes = scanHtmlNodes(code);
  assert.equal(slice(code, byTag(nodes, 'button')[0]), `<button class="cta" onclick='save("It\\'s done")'>Save</button>`);
  assert.equal(slice(code, byTag(nodes, 'p')[0]), '<p>after</p>', 'the scan continues past the tag');
});

test('a stray quote in an attribute NAME is just a character', () => {
  const code = '<div a="1" b"c=2><span>x</span></div><p>after</p>';
  const nodes = scanHtmlNodes(code);
  assert.equal(slice(code, nodes[0]), '<div a="1" b"c=2><span>x</span></div>');
  assert.equal(slice(code, byTag(nodes, 'p')[0]), '<p>after</p>');
});

test('foreign content is derived from the stack, not a counter that can go stale', () => {
  // </div> pops the unclosed <svg>; the later <section/> is HTML, so the slash is
  // ignored and it stays open (a stale foreign flag would self-close it).
  const code = '<div><svg><rect/></div><section/><p>after</p>';
  const nodes = scanHtmlNodes(code);
  assert.equal(slice(code, byTag(nodes, 'section')[0]), '<section/><p>after</p>');
  assert.equal(byTag(nodes, 'p')[0].depth, 1, 'the <p> is inside the still-open section');
});

// The cases below were cross-checked against a real browser parse: each sample was
// annotated, loaded in an iframe, and every [data-pm-node] element's tag and nearest
// annotated ancestor matched this scan. Keep them passing — they're the shapes where a
// hand-rolled scanner and the HTML5 parser most easily disagree.
test('an attribute value containing a close tag does not end the element', () => {
  const code = '<div title="a > b" data-q="</div>"><span>x</span></div><p>after</p>';
  const nodes = scanHtmlNodes(code);
  assert.equal(slice(code, nodes[0]), '<div title="a > b" data-q="</div>"><span>x</span></div>');
  assert.equal(slice(code, byTag(nodes, 'p')[0]), '<p>after</p>');
});

test('a script ends at the first close tag, exactly like the HTML parser', () => {
  // The parser does not understand JS strings: "</script>" really does end the script.
  const code = '<div><script>var s = "</script>"; var r = 1;</script><b>after</b></div>';
  const nodes = scanHtmlNodes(code);
  assert.equal(slice(code, byTag(nodes, 'script')[0]), '<script>var s = "</script>');
  assert.equal(slice(code, byTag(nodes, 'b')[0]), '<b>after</b>');
  assert.equal(slice(code, nodes[0]), code, 'the wrapping div still spans everything');
});

test('uppercase tags are normalized', () => {
  const nodes = scanHtmlNodes('<DIV CLASS="A"><SPAN>x</SPAN></DIV>');
  assert.deepEqual(nodes.map((n) => n.tag), ['div', 'span']);
  assert.equal(nodes[0].label, 'div.A');
});

test('custom element names with hyphens and digits are scanned', () => {
  const code = '<my-el-2 data-x="1"><slot-a>inner</slot-a></my-el-2><p>after</p>';
  const nodes = scanHtmlNodes(code);
  assert.deepEqual(nodes.map((n) => n.tag), ['my-el-2', 'slot-a', 'p']);
  assert.equal(slice(code, nodes[0]), '<my-el-2 data-x="1"><slot-a>inner</slot-a></my-el-2>');
});

test('select/option and dl implicit closes stay siblings', () => {
  const select = '<select><option>a<option>b</select><p>after</p>';
  const sNodes = scanHtmlNodes(select);
  assert.equal(slice(select, sNodes[1]), '<option>a');
  assert.equal(sNodes[2].depth, 1);
  const dl = '<dl><dt>t<dd>d<dt>t2<dd>d2</dl>';
  const dNodes = scanHtmlNodes(dl);
  assert.deepEqual(dNodes.slice(1).map((n) => n.depth), [1, 1, 1, 1]);
});

test('svg with foreignObject keeps HTML children nested correctly', () => {
  const code = '<svg><g><path d="M0 0"/></g><foreignObject><span>hi</span></foreignObject></svg><p>after</p>';
  const nodes = scanHtmlNodes(code);
  const span = byTag(nodes, 'span')[0];
  const fo = byTag(nodes, 'foreignobject')[0]; // tags are normalized to lower case
  assert.equal(span.parent, fo.id);
  assert.equal(slice(code, span), '<span>hi</span>');
  assert.equal(slice(code, byTag(nodes, 'p')[0]), '<p>after</p>');
});

test('every node range is well-formed and children nest inside parents', () => {
  const code = [
    '<!DOCTYPE html><html><head><style>.a{color:red}</style></head>',
    '<body><main class="wrap"><ul><li>a<li>b</ul>',
    '<table><tr><td>1<td>2</table>',
    '<svg><path d="M0 0"/></svg><br><p>tail</p></main></body></html>',
  ].join('');
  const nodes = scanHtmlNodes(code);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const node of nodes) {
    assert.ok(node.start < node.end, `${node.tag} has a positive range`);
    assert.ok(node.end <= code.length, `${node.tag} stays in bounds`);
    assert.equal(code[node.start], '<', `${node.tag} starts at a tag`);
    if (node.parent !== -1) {
      const parent = byId.get(node.parent);
      assert.ok(
        parent.start <= node.start && node.end <= parent.end,
        `${node.label} is contained by ${parent.label}`
      );
    }
  }
});
