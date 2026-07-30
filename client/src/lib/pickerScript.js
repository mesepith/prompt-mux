/**
 * Runtime injected into the sandboxed artifact preview so the user can point at
 * a part of the rendered page and edit just that part.
 *
 * The iframe is `sandbox="allow-scripts"` with NO allow-same-origin, so the
 * parent cannot touch this document directly — everything goes over
 * postMessage. Message contract (kept in sync with ArtifactPanel.jsx):
 *
 *   parent -> preview   { source: 'promptmux', type: 'picker', enabled }
 *                       { source: 'promptmux', type: 'select', id }      // id | null
 *   preview -> parent   { source: 'promptmux-preview', type: 'ready' }
 *                       { source: 'promptmux-preview', type: 'selected', node }
 *                       { source: 'promptmux-preview', type: 'rect', id, rect }
 *                       { source: 'promptmux-preview', type: 'cleared' }
 *
 * `node` = { id, label, text, rect, ancestors: [{ id, label }] } where `id` is
 * the data-pm-node stamped by annotateHtml() — i.e. an index into the source
 * scan, which is how the parent knows which characters to replace.
 *
 * Written as a real function and stringified so the bundler parses/checks it.
 * It must therefore be fully self-contained: no imports, no outer references.
 */
function pickerRuntime() {
  if (window.__PROMPTMUX_PICKER__) return;
  window.__PROMPTMUX_PICKER__ = true;

  var PARENT_SOURCE = 'promptmux';
  var SELF_SOURCE = 'promptmux-preview';
  var enabled = false;
  var selectedId = null;
  // The clicked element itself, not just its id: an artifact that clones a stamped
  // template (cloneNode / innerHTML) puts several live elements on the same id, and
  // re-querying would then highlight and measure the wrong copy.
  var selectedEl = null;
  var hoverEl = null;
  var frame = null;
  var watch = null;

  var style = document.createElement('style');
  style.textContent = [
    '.pm-pick-box{position:fixed;pointer-events:none;z-index:2147483646;border-radius:3px;',
    'box-sizing:border-box;transition:all .06s linear}',
    '.pm-pick-hover{border:1.5px dashed rgba(139,92,246,.9);background:rgba(139,92,246,.10)}',
    '.pm-pick-active{border:2px solid #8b5cf6;background:rgba(139,92,246,.14);',
    'box-shadow:0 0 0 9999px rgba(9,9,11,.28)}',
    '.pm-pick-tag{position:fixed;pointer-events:none;z-index:2147483647;',
    'font:600 11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:#fff;',
    'background:#8b5cf6;padding:2px 6px;border-radius:4px;white-space:nowrap;',
    'box-shadow:0 2px 8px rgba(0,0,0,.35)}',
    'html.pm-picking,html.pm-picking *{cursor:crosshair !important}',
    'html.pm-picking *{user-select:none !important}',
  ].join('');

  var hoverBox = document.createElement('div');
  hoverBox.className = 'pm-pick-box pm-pick-hover';
  var activeBox = document.createElement('div');
  activeBox.className = 'pm-pick-box pm-pick-active';
  var tag = document.createElement('div');
  tag.className = 'pm-pick-tag';

  function mount() {
    var root = document.documentElement;
    if (!style.isConnected) root.appendChild(style);
    if (!hoverBox.isConnected) root.appendChild(hoverBox);
    if (!activeBox.isConnected) root.appendChild(activeBox);
    if (!tag.isConnected) root.appendChild(tag);
  }

  function hide(el) {
    el.style.display = 'none';
  }

  function place(box, rect) {
    box.style.display = 'block';
    box.style.left = rect.left + 'px';
    box.style.top = rect.top + 'px';
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';
  }

  function placeTag(rect, text) {
    tag.textContent = text;
    tag.style.display = 'block';
    var above = rect.top > 22;
    tag.style.left = Math.max(2, Math.min(rect.left, window.innerWidth - 8)) + 'px';
    tag.style.top = (above ? rect.top - 20 : rect.top + rect.height + 4) + 'px';
  }

  function post(payload) {
    payload.source = SELF_SOURCE;
    try {
      window.parent.postMessage(payload, '*');
    } catch (err) {
      /* parent gone */
    }
  }

  function nodeId(el) {
    var raw = el && el.getAttribute ? el.getAttribute('data-pm-node') : null;
    if (raw === null || raw === undefined || raw === '') return null;
    var n = parseInt(raw, 10);
    return isNaN(n) ? null : n;
  }

  function target(el) {
    while (el && el.nodeType === 1) {
      if (nodeId(el) !== null) return el;
      el = el.parentElement;
    }
    return null;
  }

  function labelOf(el) {
    var label = el.tagName.toLowerCase();
    if (el.id) label += '#' + el.id;
    else {
      var cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) label += '.' + cls.join('.');
    }
    return label.length > 48 ? label.slice(0, 45) + '…' : label;
  }

  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  function find(id) {
    return document.querySelector('[data-pm-node="' + id + '"]');
  }

  /** The live element for the current selection, preferring the one clicked. */
  function currentEl() {
    if (selectedEl && selectedEl.isConnected) return selectedEl;
    return selectedId === null ? null : find(selectedId);
  }

  function describe(el) {
    var ancestors = [];
    var walk = el.parentElement;
    while (walk && walk.nodeType === 1 && ancestors.length < 12) {
      var id = nodeId(walk);
      if (id !== null) ancestors.push({ id: id, label: labelOf(walk) });
      walk = walk.parentElement;
    }
    var text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return {
      id: nodeId(el),
      label: labelOf(el),
      tag: el.tagName.toLowerCase(),
      text: text.length > 80 ? text.slice(0, 77) + '…' : text,
      rect: rectOf(el),
      ancestors: ancestors,
    };
  }

  var lastRect = '';

  function rectKey(rect) {
    return rect.left + ':' + rect.top + ':' + rect.width + ':' + rect.height;
  }

  /** Draws the current selection without notifying the parent. */
  function paintSelection() {
    var el = currentEl();
    if (!el) {
      hide(activeBox);
      hide(tag);
      lastRect = '';
      return null;
    }
    var rect = rectOf(el);
    place(activeBox, rect);
    placeTag(rect, labelOf(el));
    lastRect = rectKey(rect);
    return el;
  }

  /** Redraws and, when the geometry actually changed, tells the parent. */
  function syncNow() {
    if (selectedId !== null) {
      var el = currentEl();
      if (!el) {
        // The artifact's own JS removed the selected element — tell the parent
        // instead of leaving its edit card pointing at nothing.
        selectedId = null;
        selectedEl = null;
        watchSelection(false);
        hide(activeBox);
        hide(tag);
        lastRect = '';
        post({ type: 'cleared' });
      } else {
        var rect = rectOf(el);
        place(activeBox, rect);
        placeTag(rect, labelOf(el));
        var key = rectKey(rect);
        if (key !== lastRect) {
          lastRect = key;
          post({ type: 'rect', id: selectedId, rect: rect });
        }
      }
    }
    if (enabled && hoverEl && hoverEl.isConnected) place(hoverBox, rectOf(hoverEl));
    else hide(hoverBox);
  }

  function syncRects() {
    if (frame) return;
    frame = requestAnimationFrame(function () {
      frame = null;
      syncNow();
    });
  }

  // Scroll/resize/ResizeObserver cover most movement, but an artifact can also
  // animate or reflow the selected element on its own — a slow poll while
  // something is selected keeps the highlight and the edit card attached to it.
  function watchSelection(on) {
    if (watch) {
      clearInterval(watch);
      watch = null;
    }
    if (on) watch = setInterval(syncNow, 300);
  }

  function setEnabled(next) {
    enabled = !!next;
    document.documentElement.classList.toggle('pm-picking', enabled);
    if (!enabled) {
      hoverEl = null;
      hide(hoverBox);
    }
    paintSelection();
  }

  function select(id) {
    selectedId = id === null || id === undefined ? null : id;
    var el = selectedId === null ? null : find(selectedId);
    selectedEl = el;
    if (!el) {
      selectedId = null;
      selectedEl = null;
      watchSelection(false);
      paintSelection();
      post({ type: 'cleared' });
      return;
    }
    paintSelection();
    watchSelection(true);
    post({ type: 'selected', node: describe(el) });
  }

  document.addEventListener(
    'mousemove',
    function (e) {
      if (!enabled) return;
      var el = target(e.target);
      if (el === hoverEl) return;
      hoverEl = el;
      if (!el) {
        hide(hoverBox);
        return;
      }
      place(hoverBox, rectOf(el));
    },
    true
  );

  document.addEventListener(
    'mouseleave',
    function () {
      hoverEl = null;
      hide(hoverBox);
    },
    true
  );

  // While picking, the page must not react to clicks (no navigation, no game
  // moves) — the click is a selection gesture, not page interaction.
  function swallow(e) {
    if (!enabled) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }
  ['mousedown', 'mouseup', 'dblclick', 'submit', 'touchstart'].forEach(function (type) {
    document.addEventListener(type, swallow, true);
  });

  document.addEventListener(
    'click',
    function (e) {
      if (!enabled) return;
      swallow(e);
      var el = target(e.target);
      if (!el) return;
      selectedId = nodeId(el);
      selectedEl = el;
      paintSelection();
      watchSelection(true);
      post({ type: 'selected', node: describe(el) });
    },
    true
  );

  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    var data = e.data;
    if (!data || data.source !== PARENT_SOURCE) return;
    if (data.type === 'picker') setEnabled(data.enabled);
    else if (data.type === 'select') select(data.id);
  });

  window.addEventListener('scroll', syncRects, true);
  window.addEventListener('resize', syncRects);
  if (window.ResizeObserver) {
    try {
      new ResizeObserver(syncRects).observe(document.documentElement);
    } catch (err) {
      /* ignore */
    }
  }

  mount();
  hide(hoverBox);
  hide(activeBox);
  hide(tag);
  post({ type: 'ready' });
}

export const PICKER_SCRIPT = `(${pickerRuntime.toString()})();`;
