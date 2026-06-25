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

// Build the framed "device" that wraps one diagram: a collapsible Source panel
// on the left, sitting *beside* the diagram (not behind a tab), and — when a
// clash occurs — an attached, collapsible conflict panel inside the same border,
// so the UNSAT report obviously belongs to the diagram and not the page prose.
//
// The split is "live": the Source panel mirrors the current notation, so editing
// the diagram (in the editable variant) updates the text on the spot. Read-only
// embeds open with the source collapsed (a clean diagram); editable embeds open
// expanded, since two-way editing is the point.
//
// `editable` makes the Source panel a real <textarea> with a Run ▸ button — text →
// diagram is an *explicit* apply (Run ▸ / ⌘⏎ re-renders), not continuous binding,
// which would fight the normalizing serializer (caret jumps, dropped %% comments,
// lost node positions mid-type). Diagram → text stays live.
//
// Returns refs + hooks:
//   graphHost            — mount the graph element into this
//   conflict             — the conflict region (passed to showCoreConflict)
//   setSourceProvider(fn)— fn() returns the current notation shown in the panel
//   setRefit(fn)         — called when the diagram's area resizes (collapse/apply)
//   setApply(fn)         — fn(text) re-renders the diagram from edited text;
//                          resolves to { ok, message? } (editable only)
//   setSourceText(t,f)   — push diagram→text into the panel (won't clobber unsaved
//                          typing unless forced)
//   refreshSource(f)     — re-pull from the provider into the panel
function buildDevice(doc, opts, height, editable) {
  const h = height != null && height !== '' ? height : (opts.height != null ? opts.height : 360);
  // A bare number (or numeric string like "320") means pixels; anything else
  // (e.g. "60vh") is used verbatim. Without this, `height: 320` is invalid CSS
  // and the stage collapses to 0.
  const hCss = (typeof h === 'number' || /^\d+(\.\d+)?$/.test(String(h).trim()))
    ? parseFloat(h) + 'px'
    : String(h);
  const dark = opts.theme === 'dark';
  const C = dark
    ? { border: '#2a2f38', bg: '#181b21', chrome: '#1f232b', ink: '#e8eaee', soft: '#a7b0bd', accent: '#3fae74', accentInk: '#06140c',
        warnBg: '#3a1b18', warnInk: '#f3b5ab', warnBorder: '#5b2a23', warnAccent: '#e0796b', warnSlot: '#211311' }
    : { border: '#e2e5ea', bg: '#ffffff', chrome: '#f7f8fa', ink: '#1d2230', soft: '#5b6472', accent: '#2d8659', accentInk: '#ffffff',
        warnBg: '#f8d7da', warnInk: '#842029', warnBorder: '#f1aeb5', warnAccent: '#dc3545', warnSlot: '#fffafa' };
  const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  const MONO = '"SF Mono","JetBrains Mono","Fira Code",ui-monospace,Menlo,Consolas,monospace';
  const BREAK = 520;   // below this device width, stack the source above the diagram

  const mkBtn = (label, title) => {
    const b = doc.createElement('button');
    b.type = 'button'; b.textContent = label; if (title) b.title = title;
    b.style.cssText =
      `appearance: none; cursor: pointer; font: 11px/1 ${SANS}; padding: 4px 9px; white-space: nowrap;` +
      ` border: 1px solid ${C.border}; border-radius: 6px; background: ${C.bg}; color: ${C.ink};`;
    return b;
  };

  const device = doc.createElement('div');
  device.className = 'spytial-graph-device';
  device.dataset.spytialProcessed = '1';
  device.style.cssText =
    `margin: 12px 0; border: 1px solid ${C.border}; border-radius: 8px; overflow: hidden; background: ${C.bg};`;

  // ── frame: [ source (LHS, collapsible) | diagram ] ──
  const frame = doc.createElement('div');
  frame.style.cssText = `display: flex; width: 100%; height: ${hCss}; align-items: stretch;`;
  device.appendChild(frame);

  // ── source column (collapsible) ──
  const sourceCol = doc.createElement('div');
  sourceCol.className = 'spytial-graph-source';
  sourceCol.style.cssText = `flex: 0 0 auto; display: flex; min-width: 0; overflow: hidden; background: ${C.chrome};`;
  frame.appendChild(sourceCol);

  // expanded: header (title + actions) over the source body
  const panelExpanded = doc.createElement('div');
  panelExpanded.style.cssText = 'display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; min-width: 0;';
  const srcHeader = doc.createElement('div');
  srcHeader.style.cssText =
    `flex: 0 0 auto; display: flex; align-items: center; gap: 6px; padding: 6px 8px;` +
    ` border-bottom: 1px solid ${C.border}; background: ${C.chrome};`;
  const collapseBtn = doc.createElement('button');
  collapseBtn.type = 'button'; collapseBtn.textContent = '◂'; collapseBtn.title = 'Hide source';
  collapseBtn.style.cssText =
    `appearance: none; border: none; background: transparent; cursor: pointer; color: ${C.soft}; font: 13px/1 ${SANS}; padding: 2px 4px;`;
  const srcTitle = doc.createElement('span');
  srcTitle.textContent = 'Source';
  srcTitle.style.cssText = `font: 600 10.5px/1 ${SANS}; letter-spacing: .06em; text-transform: uppercase; color: ${C.soft};`;
  const srcStatus = doc.createElement('span');
  srcStatus.style.cssText = `flex: 0 1 auto; min-width: 0; font: 11px/1.2 ${SANS}; color: ${C.warnAccent}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`;
  const srcSpacer = doc.createElement('span');
  srcSpacer.style.cssText = 'flex: 1 1 6px; min-width: 6px;';
  srcHeader.appendChild(collapseBtn);
  srcHeader.appendChild(srcTitle);
  srcHeader.appendChild(srcStatus);
  srcHeader.appendChild(srcSpacer);
  let runBtn = null;
  if (editable) {
    runBtn = mkBtn('Run ▸', 'Apply the notation to the diagram (⌘⏎)');
    srcHeader.appendChild(runBtn);
  }
  const copyBtn = mkBtn('⧉ Copy', 'Copy the notation');
  srcHeader.appendChild(copyBtn);

  // the source body: an editable <textarea> (editable) or a read-only <pre>
  const srcBody = doc.createElement('div');
  srcBody.style.cssText = `flex: 1 1 0; min-height: 0; overflow: auto; background: ${C.bg};`;
  let srcPre = null, srcTextarea = null;
  if (editable) {
    srcBody.style.display = 'flex';
    srcBody.style.flexDirection = 'column';
    srcTextarea = doc.createElement('textarea');
    srcTextarea.spellcheck = false;
    srcTextarea.setAttribute('aria-label', 'Diagram source — edit, then Run (⌘⏎)');
    srcTextarea.style.cssText =
      `flex: 1 1 auto; min-height: 0; width: 100%; box-sizing: border-box; resize: none; border: none; outline: none;` +
      ` padding: 12px 14px; margin: 0; tab-size: 2; white-space: pre; overflow: auto;` +
      ` background: ${C.bg}; color: ${C.ink}; font: 12.5px/1.6 ${MONO};`;
    srcBody.appendChild(srcTextarea);
  } else {
    srcPre = doc.createElement('pre');
    srcPre.style.cssText =
      `margin: 0; padding: 12px 14px; white-space: pre; tab-size: 2; color: ${C.ink}; font: 12.5px/1.6 ${MONO};`;
    srcBody.appendChild(srcPre);
  }
  panelExpanded.appendChild(srcHeader);
  panelExpanded.appendChild(srcBody);
  sourceCol.appendChild(panelExpanded);

  // collapsed: a thin rail that re-opens the source on click
  const panelRail = doc.createElement('button');
  panelRail.type = 'button'; panelRail.title = 'Show source';
  panelRail.style.cssText =
    `display: none; align-items: center; justify-content: center; gap: 7px; cursor: pointer; appearance: none;` +
    ` border: none; background: ${C.chrome}; color: ${C.soft}; width: 100%; height: 100%;` +
    ` font: 600 10.5px/1 ${SANS}; letter-spacing: .08em; text-transform: uppercase;`;
  const railChev = doc.createElement('span'); railChev.textContent = '▸';
  railChev.style.cssText = 'writing-mode: horizontal-tb;';   // keep the arrow upright in a vertical rail
  const railLabel = doc.createElement('span'); railLabel.textContent = 'Source';
  panelRail.appendChild(railChev); panelRail.appendChild(railLabel);
  sourceCol.appendChild(panelRail);

  // ── diagram stage ──
  // overflow:hidden keeps the graph clipped to its frame so it can't spill over
  // the conflict panel below (the editable element doesn't clip its own canvas).
  const graphStage = doc.createElement('div');
  graphStage.style.cssText = `flex: 1 1 0; position: relative; min-width: 0; overflow: hidden; height: ${hCss};`;
  const graphHost = doc.createElement('div');
  graphHost.className = 'spytial-graph-rendered';
  graphHost.dataset.spytialProcessed = '1';
  graphHost.style.cssText = 'position: absolute; inset: 0;';
  graphStage.appendChild(graphHost);
  frame.appendChild(graphStage);

  // ── conflict region (attached, below the frame, inside the border) ──
  const conflict = doc.createElement('div');
  conflict.className = 'spytial-graph-conflict';
  conflict.style.cssText =
    `display: none; border-top: 1px solid ${C.warnBorder}; border-left: 3px solid ${C.warnAccent};`;
  const cHeader = doc.createElement('button');
  cHeader.type = 'button';
  cHeader.style.cssText =
    'appearance: none; width: 100%; text-align: left; cursor: pointer; border: none;' +
    ` display: flex; align-items: center; gap: 8px; padding: 10px 12px;` +
    ` font: 700 13px/1.3 ${SANS}; background: ${C.warnBg}; color: ${C.warnInk};`;
  const cLabel = doc.createElement('span');
  cLabel.textContent = '⚠ These rules can’t all hold';
  const cChevron = doc.createElement('span');
  cChevron.textContent = '▾';
  cChevron.style.cssText = 'margin-left: auto; font-size: 11px; opacity: .8;';
  cHeader.appendChild(cLabel); cHeader.appendChild(cChevron);
  const conflictSlot = doc.createElement('div');
  conflictSlot.className = 'spytial-graph-conflict-slot';
  conflictSlot.style.cssText = `padding: 10px 12px 12px; max-height: 340px; overflow: auto; background: ${C.warnSlot};`;
  conflict.appendChild(cHeader); conflict.appendChild(conflictSlot);
  conflict._labelEl = cLabel;   // showCoreConflict sets the headline text
  device.appendChild(conflict);

  // ── behaviors ──
  let collapsed = !editable;     // editable opens expanded; read-only opens collapsed
  let dirty = false;             // unsaved edits in the textarea (editable only)
  let lastNarrow = null;
  let getSource = () => '';
  let refit = () => {};
  let applyFn = null;

  const isNarrow = () => device.clientWidth > 0 && device.clientWidth < BREAK;

  // Emphasize Run when there are unsaved text edits to apply.
  const styleRun = () => {
    if (!runBtn) return;
    const on = dirty;
    runBtn.style.background = on ? C.accent : C.bg;
    runBtn.style.color = on ? C.accentInk : C.ink;
    runBtn.style.borderColor = on ? C.accent : C.border;
  };

  // Lay the source/diagram out for the current collapsed + width state. Row by
  // default (source on the left); below BREAK, stack the source on top.
  function relayout() {
    const narrow = isNarrow();
    frame.style.flexDirection = narrow ? 'column' : 'row';
    frame.style.height = narrow ? 'auto' : hCss;
    graphStage.style.height = hCss;
    graphStage.style.flex = narrow ? '0 0 auto' : '1 1 0';

    panelExpanded.style.display = collapsed ? 'none' : 'flex';
    panelRail.style.display = collapsed ? 'flex' : 'none';

    // separate source from diagram along whichever axis they're stacked on
    sourceCol.style.borderRight = !narrow ? `1px solid ${C.border}` : 'none';
    sourceCol.style.borderBottom = narrow ? `1px solid ${C.border}` : 'none';

    if (collapsed) {
      if (narrow) {
        sourceCol.style.width = '100%'; sourceCol.style.height = 'auto';
        panelRail.style.writingMode = 'horizontal-tb'; panelRail.style.padding = '8px 12px';
        railChev.textContent = '▾';
      } else {
        sourceCol.style.width = '30px'; sourceCol.style.height = '';
        panelRail.style.writingMode = 'vertical-rl'; panelRail.style.padding = '12px 0';
        railChev.textContent = '▸';
      }
    } else if (narrow) {
      sourceCol.style.width = '100%'; sourceCol.style.height = '170px';
    } else {
      sourceCol.style.width = 'clamp(200px, 38%, 380px)'; sourceCol.style.height = '';
    }

    // a reflow between row/column changes the diagram's box — re-fit once
    if (lastNarrow !== null && lastNarrow !== narrow) setTimeout(refit, 0);
    lastNarrow = narrow;
  }

  // Push notation into the panel. In editable mode, don't yank text out from
  // under the user mid-edit (focused or unsaved) unless forced (initial / apply).
  const setSourceText = (text, force) => {
    if (srcTextarea) {
      if (!force && (dirty || doc.activeElement === srcTextarea)) return;
      srcTextarea.value = text == null ? '' : text;
      dirty = false; srcStatus.textContent = ''; styleRun();
    } else if (srcPre) {
      srcPre.textContent = text == null ? '' : text;
    }
  };
  const refreshSource = (force) => setSourceText(getSource(), force);

  const expand = () => { collapsed = false; relayout(); refreshSource(); setTimeout(refit, 0); };
  const collapse = () => { collapsed = true; relayout(); setTimeout(refit, 0); };
  collapseBtn.addEventListener('click', collapse);
  panelRail.addEventListener('click', expand);

  copyBtn.addEventListener('click', async () => {
    const text = getSource();
    try {
      await navigator.clipboard.writeText(text);
      const prev = copyBtn.textContent; copyBtn.textContent = '✓ Copied';
      setTimeout(() => { copyBtn.textContent = prev; }, 1200);
    } catch (_) { window.prompt('spytial-graph notation:', text); }
  });

  // text → diagram: explicit apply (Run ▸ / ⌘⏎). Re-render, then snap the panel
  // to the canonical round-trip so what's shown matches the diagram exactly.
  async function doApply() {
    if (!applyFn || !srcTextarea) return;
    const prev = runBtn ? runBtn.textContent : '';
    if (runBtn) { runBtn.disabled = true; runBtn.textContent = 'Running…'; }
    srcStatus.textContent = '';
    let res;
    try { res = await applyFn(srcTextarea.value); }
    catch (err) { res = { ok: false, message: err && err.message ? err.message : String(err) }; }
    if (runBtn) { runBtn.disabled = false; runBtn.textContent = prev || 'Run ▸'; }
    if (res && res.ok) {
      refreshSource(true);
    } else {
      srcStatus.textContent = '⚠ ' + ((res && res.message) || 'could not apply');
      srcStatus.title = srcStatus.textContent;
    }
  }
  if (runBtn) runBtn.addEventListener('click', doApply);
  if (srcTextarea) {
    srcTextarea.addEventListener('input', () => { dirty = true; srcStatus.textContent = ''; styleRun(); });
    srcTextarea.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); doApply(); }
    });
  }

  let cCollapsed = false;
  cHeader.addEventListener('click', () => {
    cCollapsed = !cCollapsed;
    conflictSlot.style.display = cCollapsed ? 'none' : 'block';
    cChevron.textContent = cCollapsed ? '▸' : '▾';
  });

  relayout();
  styleRun();
  // Re-flow on width changes (row ⇄ column stacking at BREAK). A ResizeObserver
  // catches container-only changes (e.g. a sidebar toggle); a window-resize
  // listener is the broadly-compatible fallback for viewport changes. Keep the
  // observer referenced on the element — an unreferenced ResizeObserver can be
  // GC'd, which silently stops it firing.
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => relayout());
    ro.observe(device);
    device._spytialResizeObserver = ro;
  }
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('resize', relayout);
  }

  return {
    device, graphHost, conflict,
    setSourceProvider: (fn) => { getSource = fn; },
    setRefit: (fn) => { refit = fn; },
    setApply: (fn) => { applyFn = fn; },
    setSourceText,
    refreshSource,
  };
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
    const ui = buildDevice(doc, opts, dataH, editable);
    host.replaceWith(ui.device);

    try {
      if (editable) {
        const graphEl = mountInputGraph(ui.graphHost, { theme: opts.theme });
        ui.setRefit(() => refit(graphEl));

        // Surface the UNSAT core, attached below the graph, and keep it live:
        // every edit re-reads the element's constraint error, so resolving the
        // clash (e.g. deleting the offending edge) clears the panel on the spot.
        const readErr = () => {
          try { return graphEl.getCurrentConstraintError ? graphEl.getCurrentConstraintError() : null; }
          catch (_) { return null; }
        };
        const reflectConflict = (err) => {
          const e = err !== undefined ? err : readErr();
          if (e) showCoreConflict(doc, ui.conflict, e, null);
          else clearCoreConflict(ui.conflict);
        };

        let handle = null;
        let unsub = null;
        let applying = false;   // ignore the diagram→text echo while re-rendering from text

        // (Re)bind to a handle: the Source panel mirrors its notation, and edits
        // flow back into the panel — unless we're mid-apply (our own re-render).
        const wire = (h) => {
          if (unsub) { unsub(); unsub = null; }
          handle = h;
          ui.setSourceProvider(() => {
            try { return (handle && handle.getSource && handle.getSource()) || source; }
            catch (_) { return source; }
          });
          if (h && typeof h.onChange === 'function') {
            unsub = h.onChange(({ source: s, error }) => {
              if (applying) return;
              ui.setSourceText(s);          // diagram → text (keeps unsaved typing)
              reflectConflict(error || null);
            });
          }
        };

        // text → diagram: explicit Run ▸ / ⌘⏎ re-renders onto the same element.
        ui.setApply(async (text) => {
          applying = true;
          let h;
          try { h = await renderSpytialGraphEditable(graphEl, text); }
          catch (err) { applying = false; return { ok: false, message: err && err.message ? err.message : String(err) }; }
          applying = false;
          if (h && h.applied === false) return { ok: false, message: h.reason || 'no nodes parsed from source' };
          wire(h);
          refit(graphEl);
          reflectConflict();
          return { ok: true };
        });

        wire(await renderSpytialGraphEditable(graphEl, source));
        refit(graphEl);
        ui.refreshSource(true);             // initial notation into the (expanded) textarea
        reflectConflict();
        setTimeout(reflectConflict, 500);
        results.push({ host: ui.graphHost, editable: true, applied: handle && handle.applied, handle });
      } else {
        const graphEl = mountGraph(ui.graphHost, { theme: opts.theme });
        const result = await renderSpytialGraph(graphEl, source);
        ui.setRefit(() => refit(graphEl));
        refit(graphEl);
        ui.setSourceProvider(() => source);
        ui.refreshSource(true);
        // A clash still draws the best-feasible layout; explain it below.
        showCoreConflict(doc, ui.conflict, result.error, result.selectorErrors);
        results.push({ host: ui.graphHost, applied: result.applied, result });
      }
    } catch (err) {
      renderError(doc, ui.graphHost, err && err.message ? err.message : String(err));
      results.push({ host: ui.graphHost, error: err });
    }
  }

  return results;
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

// Show the IIS for a diagram's conflict region (built by buildDevice), via
// spytial-core's component. No clash → clears instead.
async function showCoreConflict(doc, conflict, error, selectorErrors) {
  if (!error && !(selectorErrors && selectorErrors.length)) { clearCoreConflict(conflict); return; }
  if (!(await ensureErrorComponent())) return;
  const host = getErrorHost(doc);
  const slot = conflict.querySelector('.spytial-graph-conflict-slot');
  if (conflict._labelEl) {
    conflict._labelEl.textContent = (selectorErrors && selectorErrors.length)
      ? '⚠ A selector didn’t resolve'
      : '⚠ These rules can’t all hold';
  }
  if (_errOwner && _errOwner !== conflict) _errOwner.style.display = 'none';
  conflict.style.display = 'block';
  slot.appendChild(host);                 // relocate the single modal under this diagram
  if (!_errMounted) { window.mountErrorMessageModal(host.id); _errMounted = true; }
  _errOwner = conflict;
  window.clearAllErrors && window.clearAllErrors();
  dispatchConflict(error, selectorErrors);
}

// Clear the IIS if `conflict` is the region currently showing it (edit fixed it).
function clearCoreConflict(conflict) {
  if (_errOwner === conflict) {
    window.clearAllErrors && window.clearAllErrors();
    conflict.style.display = 'none';
    _errOwner = null;
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
