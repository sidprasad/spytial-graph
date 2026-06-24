// Markdown integration — render ```spytial-graph fenced blocks the way people
// render ```mermaid, entirely client-side.
//
// This is framework-agnostic: it scans *already-rendered* HTML for the code
// blocks a markdown renderer (marked, markdown-it, MkDocs, Docusaurus, GitHub
// pipelines, …) produces for a fenced block tagged `spytial-graph`, and swaps
// each one for a live <webcola-cnd-graph>. So a doc author writes:
//
//     ```spytial-graph
//     flowchart TD
//       A -->|left| B
//       A -->|right| C
//       class A,B,C tree
//
//     @orientation(selector=_links, directions=[below])
//     @orientation(selector=left,  directions=[left])
//     @orientation(selector=right, directions=[right])
//     ```
//
// …and gets a live, draggable constraint diagram.
//
// Usage on a page — one import, one call (the engine is injected for you if it
// isn't already on the page):
//
//     import { autoRender } from '.../src/markdown.js';
//     autoRender();
//
// or, to render a specific subtree after you inject HTML yourself:
//
//     import { renderSpytialGraphs } from '.../src/markdown.js';
//     await renderSpytialGraphs(myContainer);

import { mountGraph, renderSpytialGraph, mountInputGraph, renderSpytialGraphEditable } from './index.js';

// Languages that mark a SpyTial graph block. `spytial-graph` is canonical;
// `spytial` is accepted as an alias.
const LANGS = ['spytial-graph', 'spytial'];

// Editable variants. Most markdown renderers keep only the first info-string
// token as the language class, so a dedicated language is the portable way to
// opt a block into the editor (` ```spytial-graph-editable `). A `data-editable`
// attribute on the host (hand-authored HTML) works too, as does opts.editable.
const EDITABLE_LANGS = ['spytial-graph-editable', 'spytial-editable'];
const ALL_LANGS = [...LANGS, ...EDITABLE_LANGS];

// CSS selectors covering how common markdown renderers tag a fenced block:
//   marked / markdown-it / Prism / highlight.js → <pre><code class="language-spytial-graph">
//   some pipelines emit the class on the <pre>   → <pre class="language-spytial-graph">
//   hand-authored containers                     → <div class="spytial-graph">
function blockSelector() {
  const sels = [];
  for (const lang of ALL_LANGS) {
    sels.push(`pre > code.language-${lang}`);
    sels.push(`code.language-${lang}`);
    sels.push(`pre.language-${lang}`);
    sels.push(`pre.${lang}`);
    sels.push(`div.${lang}`);
  }
  return sels.join(', ');
}

// classList matching is whole-token, so `language-spytial-graph` never matches a
// `language-spytial-graph-editable` block (the editable langs are distinct).
function hasLang(el, lang) {
  return !!(el && el.classList && (el.classList.contains(`language-${lang}`) || el.classList.contains(lang)));
}

// Should this block render editable? Via a dedicated editable language, a
// `data-editable` attribute on the host/code, or a global opts.editable.
function isEditableBlock(el, host, opts) {
  if (opts && opts.editable) return true;
  for (const lang of EDITABLE_LANGS) {
    if (hasLang(el, lang) || hasLang(host, lang)) return true;
  }
  const de =
    (host.getAttribute && host.getAttribute('data-editable')) ??
    (el.getAttribute && el.getAttribute('data-editable'));
  return de != null && de !== 'false';
}

// The element we replace in the DOM: for a <code> inside a <pre>, replace the
// whole <pre>; otherwise replace the matched element itself.
function hostFor(el) {
  if (el.tagName === 'CODE' && el.parentElement && el.parentElement.tagName === 'PRE') {
    return el.parentElement;
  }
  return el;
}

function collectBlocks(root, opts = {}) {
  const found = new Map(); // host element → { source, editable } (dedup by host)
  for (const el of root.querySelectorAll(blockSelector())) {
    const host = hostFor(el);
    if (host.dataset && host.dataset.spytialProcessed) continue;
    if (found.has(host)) continue;
    // textContent is entity-decoded, so `-->` and `>` come through verbatim.
    found.set(host, { source: el.textContent, editable: isEditableBlock(el, host, opts) });
  }
  return found;
}

// Is the spytial-core engine (+ the custom element) ready on the page?
function engineReady() {
  const core =
    (typeof window !== 'undefined' && (window.spytialcore || window.CndCore || window.CnDCore)) ||
    (typeof globalThis !== 'undefined' && (globalThis.spytialcore || globalThis.CndCore));
  return !!(
    core &&
    core.JSONDataInstance &&
    core.LayoutInstance &&
    core.parseLayoutSpec &&
    core.SGraphQueryEvaluator &&
    typeof customElements !== 'undefined' &&
    customElements.get('webcola-cnd-graph')
  );
}

// Wait (poll) for the engine to finish loading. spytial-core exposes its global
// asynchronously, so a page may call us before it's ready.
export function whenEngineReady(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (engineReady()) return resolve();
    const start = Date.now();
    (function poll() {
      if (engineReady()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error('spytial-core engine did not load (check the CDN scripts)'));
      }
      setTimeout(poll, 50);
    })();
  });
}

// The three scripts the renderer needs, in dependency order (webcola needs d3;
// spytial-core needs both). Loaded only if the page hasn't already included them.
const ENGINE_DEPS = [
  'https://d3js.org/d3.v4.min.js',
  'https://cdn.jsdelivr.net/npm/webcola@3.4.0/WebCola/cola.min.js',
  'https://cdn.jsdelivr.net/npm/spytial-core@2.9.1/dist/browser/spytial-core-complete.global.js',
];

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded) return resolve();
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('failed to load ' + src)), { once: true });
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.addEventListener('load', () => { s.dataset.loaded = '1'; resolve(); }, { once: true });
    s.addEventListener('error', () => reject(new Error('failed to load ' + src)), { once: true });
    document.head.appendChild(s);
  });
}

// Ensure the renderer engine is present, injecting the CDN scripts if the page
// didn't already include them. Lets a page bootstrap from a single import. Pass
// { deps: [...] } to pin/host the scripts yourself, or skip injection by having
// already loaded spytial-core.
export async function ensureEngineLoaded(opts = {}) {
  if (engineReady()) return;
  for (const src of (opts.deps || ENGINE_DEPS)) {
    await loadScript(src);
  }
  await whenEngineReady(opts.timeoutMs);
}

function makeContainer(doc, opts) {
  const wrap = doc.createElement('div');
  wrap.className = 'spytial-graph-rendered';
  wrap.dataset.spytialProcessed = '1';
  const h = opts.height != null ? opts.height : 360;
  wrap.style.cssText =
    `position: relative; width: 100%; height: ${typeof h === 'number' ? h + 'px' : h};` +
    ' border: 1px solid #e2e5ea; border-radius: 8px; overflow: hidden; margin: 12px 0; background: #fff;';
  return wrap;
}

function renderError(doc, host, message) {
  const pre = doc.createElement('pre');
  pre.className = 'spytial-graph-error';
  pre.dataset.spytialProcessed = '1';
  pre.style.cssText =
    'color: #b00020; background: #fff3f3; border: 1px solid #f3c2c2; border-radius: 8px;' +
    ' padding: 10px 12px; margin: 12px 0; white-space: pre-wrap; font-size: 13px;';
  pre.textContent = 'spytial-graph error: ' + message;
  host.replaceWith(pre);
}

// Render every spytial-graph block under `root` (default: the whole document).
// Returns an array of per-block results: { host, applied?, error?, result? }.
//
//   opts.height   — diagram height (number px or CSS string). Default 360.
//                   A block can override with a data-height attribute.
//   opts.theme    — 'light' | 'dark' passed to mountGraph.
//   opts.injectEngine — inject the CDN engine scripts if absent (default true).
export async function renderSpytialGraphs(root = document, opts = {}) {
  const doc = root.ownerDocument || (root.nodeType === 9 ? root : document);
  if (opts.injectEngine !== false) {
    await ensureEngineLoaded(opts);
  } else {
    await whenEngineReady(opts.timeoutMs);
  }

  const blocks = collectBlocks(root, opts);
  const results = [];

  const refit = (graphEl) => {
    try { graphEl.resetViewToFitContent && graphEl.resetViewToFitContent(); } catch (_) {}
    setTimeout(() => {
      try { graphEl.resetViewToFitContent && graphEl.resetViewToFitContent(); } catch (_) {}
    }, 400);
  };

  for (const [host, { source, editable }] of blocks) {
    // Per-block height override via `data-height` on the host or its <code>.
    const dataH = host.getAttribute && host.getAttribute('data-height');

    // Outer block owns the vertical rhythm: the graph sits in a fixed-height
    // frame, and any constraint-clash explanation (the UNSAT core) renders in a
    // slot *below* it — never overlapping the diagram.
    const outer = doc.createElement('div');
    outer.className = 'spytial-graph-block';
    outer.dataset.spytialProcessed = '1';
    outer.style.cssText = 'margin: 12px 0;';
    const wrap = makeContainer(doc, dataH ? { ...opts, height: dataH } : opts);
    wrap.style.margin = '0';
    outer.appendChild(wrap);
    host.replaceWith(outer);

    const conflictSlot = doc.createElement('div');
    conflictSlot.className = 'spytial-graph-conflict-slot';
    conflictSlot.style.cssText = 'margin-top: 8px; display: none;';
    outer.appendChild(conflictSlot);

    try {
      if (editable) {
        const graphEl = mountInputGraph(wrap, { theme: opts.theme });
        const handle = await renderSpytialGraphEditable(graphEl, source);
        refit(graphEl);
        // A "copy notation" affordance makes the round-trip usable in docs.
        if (handle && handle.applied !== false) addCopyNotationButton(doc, wrap, handle);
        // Surface the UNSAT core below the graph, and keep it live: every edit
        // re-reads the element's constraint error, so resolving the clash (e.g.
        // deleting the offending edge) clears the panel on the spot.
        const readErr = () => {
          try { return graphEl.getCurrentConstraintError ? graphEl.getCurrentConstraintError() : null; }
          catch (_) { return null; }
        };
        showCoreConflict(doc, conflictSlot, readErr(), null);
        setTimeout(() => {
          const e = readErr();
          if (e) showCoreConflict(doc, conflictSlot, e, null);
          else clearCoreConflict(conflictSlot);
        }, 500);
        if (handle && typeof handle.onChange === 'function') {
          handle.onChange(({ error }) => {
            if (error) showCoreConflict(doc, conflictSlot, error, null);
            else clearCoreConflict(conflictSlot);
          });
        }
        results.push({ host: wrap, editable: true, applied: handle && handle.applied, handle });
      } else {
        const graphEl = mountGraph(wrap, { theme: opts.theme });
        const result = await renderSpytialGraph(graphEl, source);
        refit(graphEl);
        // A clash still draws the best-feasible layout; explain it below.
        showCoreConflict(doc, conflictSlot, result.error, result.selectorErrors);
        results.push({ host: wrap, applied: result.applied, result });
      }
    } catch (err) {
      renderError(doc, wrap, err && err.message ? err.message : String(err));
      results.push({ host: wrap, error: err });
    }
  }

  return results;
}

// A small overlay button that copies an editable block's current graph back to
// spytial-graph notation (handle.getSource()) — the round-trip, in a doc.
function addCopyNotationButton(doc, wrap, handle) {
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'spytial-graph-copy';
  btn.textContent = '⧉ notation';
  btn.title = 'Copy this graph as spytial-graph notation';
  btn.style.cssText =
    'position: absolute; top: 8px; right: 8px; z-index: 9; font: inherit; font-size: 12px;' +
    ' padding: 4px 9px; border: 1px solid #cdd2db; border-radius: 6px; background: #fff;' +
    ' color: #1d2230; cursor: pointer; opacity: .85;';
  btn.addEventListener('click', async () => {
    const text = handle.getSource();
    try {
      await navigator.clipboard.writeText(text);
      const prev = btn.textContent;
      btn.textContent = '✓ copied';
      setTimeout(() => { btn.textContent = prev; }, 1200);
    } catch (_) {
      window.prompt('spytial-graph notation:', text);
    }
  });
  wrap.appendChild(btn);
}

// ── Constraint-clash explanation (the UNSAT core) ───────────────────────────
// Reuse spytial-core's own IIS/error component — the same one the playground
// mounts — instead of re-implementing the report. Its React build is lazy-loaded
// the first time a clash appears, so conflict-free pages never pay for it. The
// component is backed by a *page-level singleton* error store (window.show*Error
// → one shared state), so we keep a single mounted modal and relocate it below
// whichever diagram currently has the displayed clash: one IIS panel at a time,
// which is what the component is designed for.
const ERROR_COMPONENT_JS =
  'https://cdn.jsdelivr.net/npm/spytial-core@2.9.1/dist/components/react-component-integration.global.js';
const ERROR_COMPONENT_CSS =
  'https://cdn.jsdelivr.net/npm/spytial-core@2.9.1/dist/components/react-component-integration.css';

let _errLoading = null;   // promise: the lazy component load
let _errHost = null;      // the single <div> the modal renders into
let _errMounted = false;  // has mountErrorMessageModal run for _errHost yet?
let _errOwner = null;     // the conflict slot currently showing the modal

function errorComponentReady() {
  return typeof window !== 'undefined' && typeof window.mountErrorMessageModal === 'function';
}

// Lazily inject spytial-core's React error component (JS + CSS), once.
async function ensureErrorComponent() {
  if (errorComponentReady()) return true;
  if (!_errLoading) {
    _errLoading = (async () => {
      if (!document.querySelector(`link[href="${ERROR_COMPONENT_CSS}"]`)) {
        const l = document.createElement('link');
        l.rel = 'stylesheet'; l.href = ERROR_COMPONENT_CSS;
        document.head.appendChild(l);
      }
      await loadScript(ERROR_COMPONENT_JS);
    })();
  }
  try { await _errLoading; } catch (_) {}
  return errorComponentReady();
}

function getErrorHost(doc) {
  if (_errHost) return _errHost;
  const div = doc.createElement('div');
  div.id = 'spytial-graph-iis-host';
  div.className = 'spytial-graph-iis';
  _errHost = div;
  return div;
}

// Map a layout error onto spytial-core's show* API — the exact dispatch the
// playground uses in its handleConflict().
function dispatchConflict(error, selectorErrors) {
  if (selectorErrors && selectorErrors.length) {
    window.showSelectorErrors && window.showSelectorErrors(selectorErrors);
    return;
  }
  if (!error) return;
  if (error.errorMessages) {
    if (error.type === 'hidden-node-conflict' && window.showHiddenNodeConflict) {
      window.showHiddenNodeConflict(error.errorMessages);
    } else if (window.showPositionalError) {
      window.showPositionalError(error.errorMessages);
    } else if (window.showGeneralError) {
      window.showGeneralError(error.message);
    }
  } else if (error.overlappingNodes || error.type === 'group-overlap') {
    window.showGroupOverlapError && window.showGroupOverlapError(error.message, error.source);
  } else {
    window.showGeneralError && window.showGeneralError(error.message);
  }
}

// Show the IIS for `slot`'s diagram, in the slot below it, via spytial-core's
// component. No clash → clears instead.
async function showCoreConflict(doc, slot, error, selectorErrors) {
  if (!error && !(selectorErrors && selectorErrors.length)) { clearCoreConflict(slot); return; }
  if (!(await ensureErrorComponent())) return;
  const host = getErrorHost(doc);
  if (_errOwner && _errOwner !== slot) _errOwner.style.display = 'none';
  slot.style.display = '';
  slot.appendChild(host);                 // relocate the single modal under this diagram
  if (!_errMounted) { window.mountErrorMessageModal(host.id); _errMounted = true; }
  _errOwner = slot;
  window.clearAllErrors && window.clearAllErrors();
  dispatchConflict(error, selectorErrors);
}

// Clear the IIS if `slot` is the one currently showing it (e.g. an edit fixed it).
function clearCoreConflict(slot) {
  if (_errOwner === slot) {
    window.clearAllErrors && window.clearAllErrors();
    slot.style.display = 'none';
  }
}

// Render every spytial-graph block once the DOM is ready, injecting the engine
// if needed. The one-liner a page adds to turn on rendering.
export function autoRender(opts = {}) {
  const run = () => {
    renderSpytialGraphs(document, opts).catch((err) => {
      // Surface load failures on the console rather than failing silently.
      console.error('[spytial-graph] auto-render failed:', err);
    });
  };
  if (typeof document !== 'undefined' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
}
