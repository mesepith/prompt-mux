/**
 * Plain text of a rendered code block.
 *
 * `rehype-highlight` replaces the raw string inside a `<code>` with a tree of
 * `<span class="hljs-…">` elements, so the children React hands the renderer are
 * a mix of strings and elements. `String(children)` on that array stringifies
 * every element to "[object Object]" — which is why the copy button used to put
 * `[object Object],\n,[object Object]` on the clipboard, and why counting its
 * newlines undercounted the lines (only the ones between spans survived).
 *
 * So walk the tree instead. Accepts anything React accepts as children; only
 * `props.children` is ever read, so it works on real elements and on the plain
 * objects the tests use.
 */
export function codeText(children) {
  if (children === null || children === undefined || typeof children === 'boolean') return '';
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) {
    let out = '';
    for (const child of children) out += codeText(child);
    return out;
  }
  // A React element (or anything element-shaped): recurse into its children.
  if (typeof children === 'object' && children.props) return codeText(children.props.children);
  return '';
}

/** Line count of a code block, ignoring the trailing newline markdown adds. */
export function countLines(text) {
  if (!text) return 0;
  return text.replace(/\n$/, '').split('\n').length;
}

/** The right-aligned gutter column: "1\n2\n3…", rendered as one text node. */
export function gutterText(lineCount) {
  let out = '';
  for (let i = 1; i <= lineCount; i++) out += i === 1 ? '1' : `\n${i}`;
  return out;
}
