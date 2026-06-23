// spytial-graph — render a small graph notation (nodes, edges, inline spatial
// @annotations) through SpyTial's standard WebCola CnD renderer.
//
// Pipeline (webcola-cnd-graph owns both layout AND drawing):
//
//   spytial-graph source
//     → annotations.js    extract inline @orientation(...) → { source, specYaml }
//     → parse.js          { nodes, edges, classesPerNode }
//     → relationalize.js  { atoms, relations, hiddenRelations }
//     → JSONDataInstance + SGraphQueryEvaluator + parseLayoutSpec
//     → LayoutInstance.generateLayout  → { layout, error, selectorErrors }
//     → <webcola-cnd-graph>.renderLayout(layout)
//
// spytial-core is a peer dependency loaded on the page (CDN or bundler) as the
// global `window.spytialcore` (legacy alias `CndCore`); it auto-registers the
// <webcola-cnd-graph> custom element and needs d3 v4 + cola.js present. We do
// NOT import it, so this module loads as a bare ES module in the browser.

import { parseGraph } from './parse.js';
import { registerSpec, clearRegistry, mergeSpecsForClasses, mergeSpecStrings } from './registry.js';
import { relationalize, DEFAULT_RELATION } from './relationalize.js';
import { extractAnnotations } from './annotations.js';
import { serializeToSpytialGraph } from './serialize.js';

export { registerSpec, clearRegistry, mergeSpecsForClasses, mergeSpecStrings, extractAnnotations, serializeToSpytialGraph };

function getSpytialCore() {
  const s =
    (typeof window !== 'undefined' && (window.spytialcore || window.CndCore || window.CnDCore)) ||
    globalThis.spytialcore ||
    globalThis.CndCore;
  if (!s) {
    throw new Error(
      'spytial-graph: spytial-core is not loaded. Include ' +
        'spytial-core-complete.global.js (plus d3 v4 and cola.js) on the page.'
    );
  }
  return s;
}

// Create (or reuse) a custom-element graph of the given tag inside `container`.
// If `container` already *is* such an element, it's returned as-is; otherwise an
// existing child of that tag is reused, or a new one is created and appended.
function mountElement(container, tagName, opts) {
  if (!(container instanceof Element)) {
    throw new Error('mountGraph: container must be an Element');
  }
  if (container.tagName && container.tagName.toLowerCase() === tagName) {
    return container;
  }
  let el = container.querySelector(tagName);
  if (!el) {
    el = document.createElement(tagName);
    if (opts.width != null) el.setAttribute('width', String(opts.width));
    if (opts.height != null) el.setAttribute('height', String(opts.height));
    if (opts.theme) el.setAttribute('theme', opts.theme);
    el.setAttribute('aria-label', opts.ariaLabel || 'Spytial constraint diagram');
    container.appendChild(el);
  }
  return el;
}

// Create (or reuse) a read-only <webcola-cnd-graph> element inside `container`.
// Returns the graph element to pass to renderSpytialGraph.
export function mountGraph(container, opts = {}) {
  return mountElement(container, 'webcola-cnd-graph', opts);
}

// Create (or reuse) an editable <structured-input-graph> element inside
// `container`. Returns the element to pass to renderSpytialGraphEditable. The
// custom element is registered by spytial-core's global build (≥ 2.9).
export function mountInputGraph(container, opts = {}) {
  return mountElement(container, 'structured-input-graph', opts);
}

// Blank the synthetic `_` name that unlabeled edges carry, so the rendered
// graph doesn't show "_" on every plain `A -> B`.
function blankDefaultLabels(layout) {
  if (!layout || !Array.isArray(layout.edges)) return;
  for (const edge of layout.edges) {
    if (edge.relationName === DEFAULT_RELATION || edge.label === DEFAULT_RELATION) {
      edge.showLabel = false;
      edge.label = '';
    }
  }
}

// Resolve the layout-rules YAML by merging every source of constraints, in order:
//   1. specs registered (via registerSpec) for the classes used in this source,
//      plus an optional `opts.extraSpec`
//   2. inline `@annotation` spec compiled from the diagram source (`annoYaml`)
//   3. an explicit `opts.rules` string (advanced escape hatch)
// Inline annotations are the primary authoring model, but all sources compose;
// the merge is the shared concat used by the class registry. Empty rules are
// fine — Spytial still produces a faithful default diagram.
function resolveRules(parsed, opts, annoYaml) {
  const usedClasses = new Set();
  for (const cs of parsed.classesPerNode.values()) {
    for (const c of cs) usedClasses.add(c);
  }
  const registryYaml = mergeSpecsForClasses(Array.from(usedClasses), opts.extraSpec);
  return mergeSpecStrings([
    registryYaml,
    annoYaml,
    typeof opts.rules === 'string' ? opts.rules : '',
  ]);
}

// Inject `hideField` directives for the selector-only relations so they stay
// queryable in selectors but are not drawn as duplicate edges. We mutate the
// parsed spec's directive list directly (the layout spec's data model), which
// avoids fragile YAML string surgery.
function hideRelations(spec, hiddenRelations) {
  if (!spec || !hiddenRelations || hiddenRelations.length === 0) return;
  if (!spec.directives) spec.directives = {};
  if (!Array.isArray(spec.directives.hiddenFields)) spec.directives.hiddenFields = [];
  const hidden = spec.directives.hiddenFields;
  for (const field of hiddenRelations) {
    if (!hidden.some(h => h && h.field === field)) hidden.push({ field });
  }
}

// Render a spytial-graph `source` onto a <webcola-cnd-graph> element using
// SpyTial's standard constraint-layout pipeline.
//
//   graphEl  — a <webcola-cnd-graph> element (see mountGraph)
//   source   — spytial-graph text (nodes/edges) with inline `@orientation(...)`
//              spatial annotations (see annotations.js)
//   opts     — { rules?: string, extraSpec?: string, validator?: 'qualitative'|'kiwi' }
//
// Returns { applied, layout, error, selectorErrors, annotationErrors, parsed,
//           data, instance, rules, hiddenRelations }.
export async function renderSpytialGraph(graphEl, source, opts = {}) {
  if (!graphEl || typeof graphEl.renderLayout !== 'function') {
    throw new Error(
      'renderSpytialGraph: graphEl must be a <webcola-cnd-graph> element. ' +
        'Use mountGraph(container) to create one.'
    );
  }

  const spytial = getSpytialCore();
  const { JSONDataInstance, SGraphQueryEvaluator, parseLayoutSpec, LayoutInstance } = spytial;
  for (const [name, fn] of Object.entries({ JSONDataInstance, SGraphQueryEvaluator, parseLayoutSpec, LayoutInstance })) {
    if (!fn) throw new Error(`spytial-graph: spytial-core is missing ${name}; need spytial-core ≥ 2.9`);
  }

  // 0. lift inline `@orientation(...)` annotations out of the source before
  //    parsing the graph; they compile to a layout spec, not graph syntax.
  const { source: cleanSource, specYaml: annoYaml, errors: annotationErrors } =
    extractAnnotations(source);

  const parsed = parseGraph(cleanSource);
  if (parsed.nodes.size === 0) {
    return { applied: false, reason: 'no nodes parsed from source', parsed, annotationErrors };
  }

  // 1. graph → relational data instance (+ which relations are selector-only)
  const { atoms, relations, hiddenRelations } = relationalize(parsed);
  const data = { atoms, relations };
  const instance = new JSONDataInstance(data);

  // 2. relational evaluator
  const evaluator = new SGraphQueryEvaluator();
  evaluator.initialize({ sourceData: instance });

  // 3. layout rules (YAML) → parsed spec, then hide the selector-only relations
  const rules = resolveRules(parsed, opts, annoYaml);
  let spec;
  try {
    spec = parseLayoutSpec(rules || '');
  } catch (err) {
    throw new Error(`spytial-graph: layout rules parse error: ${err.message}`);
  }
  hideRelations(spec, hiddenRelations);

  // 4. solve (qualitative validator → IIS clash reporting / counterfactual)
  const li = new LayoutInstance(spec, evaluator, 0, true, undefined, opts.validator || 'qualitative');
  const result = li.generateLayout(instance);
  const layout = result.layout;
  const selectorErrors = result.selectorErrors || [];
  const error = result.error || null;

  // 5. reflect unsat state on the element (drives the renderer's conflict styling)
  if (selectorErrors.length > 0 || error) graphEl.setAttribute('unsat', '');
  else graphEl.removeAttribute('unsat');

  // 6. render. On a constraint clash, `layout` is the best-feasible
  //    counterfactual — still worth drawing. Selector errors mean the spec
  //    itself is malformed, so we skip drawing a degenerate layout.
  let applied = false;
  if (layout && selectorErrors.length === 0) {
    blankDefaultLabels(layout);
    if (typeof graphEl.clear === 'function') graphEl.clear();
    await graphEl.renderLayout(layout);
    applied = true;
  }

  return { applied, layout, error, selectorErrors, annotationErrors, parsed, data, instance, rules, hiddenRelations };
}

// ── Editable rendering ───────────────────────────────────────────────────────
// The same graph, but rendered onto spytial-core's <structured-input-graph>
// editor instead of the read-only <webcola-cnd-graph>. You can add / delete
// nodes, drag to connect edges, rename relations — constraints re-solve live —
// and at any time *re-get the notation* via the handle's getSource(). That
// round-trip (text → visual → edit → text) is the point.

// Express the selector-only relations as `hideField` directives in authoring
// YAML. The read-only path mutates a parsed spec's `hiddenFields`; the editor
// parses a spec *string* internally, so we hand it the directives in YAML and
// let parseLayoutSpec fold them into hiddenFields (layoutspec maps hideField →
// hiddenFields). Field names are single-quoted so `_links` / hyphenated classes
// stay valid scalars.
function hideFieldsYaml(hiddenRelations) {
  if (!hiddenRelations || hiddenRelations.length === 0) return '';
  let out = 'directives:\n';
  for (const field of hiddenRelations) {
    out += `  - hideField: { field: '${String(field).replace(/'/g, "''")}' }\n`;
  }
  return out;
}

// The live instance the editor is currently backed by. clearAllItems() swaps in
// a fresh instance, so always ask the element rather than caching it.
function liveInstance(el, fallback) {
  try {
    return (typeof el.getDataInstance === 'function' && el.getDataInstance()) || fallback;
  } catch (_) {
    return fallback;
  }
}

// Build the handle returned by renderSpytialGraphEditable.
function buildEditableHandle(el, initialInstance, annotationLines, meta) {
  const getValue = () => {
    const inst = liveInstance(el, initialInstance);
    return inst && typeof inst.reify === 'function' ? inst.reify() : { atoms: [], relations: [] };
  };
  // The headline: re-get spytial-graph notation for the current (edited) graph,
  // with the original spatial @annotations re-appended verbatim.
  const getSource = () => serializeToSpytialGraph(getValue(), { annotations: annotationLines });

  // Subscribe to edits. Every mutation — toolbar, drag-to-connect, delete,
  // keyboard — flows through the data instance, which emits these four events;
  // that's a more reliable signal than the element's constraint events (which
  // only fire on error-state transitions). Coalesce a burst of synchronous
  // mutations (e.g. an edge rename = remove + add) into one callback.
  function onChange(cb) {
    if (typeof cb !== 'function') return () => {};
    const DATA_EVENTS = ['atomAdded', 'atomRemoved', 'relationTupleAdded', 'relationTupleRemoved'];
    let bound = null;
    let scheduled = false;
    const fire = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        let error = null;
        try { error = el.getCurrentConstraintError ? el.getCurrentConstraintError() : null; } catch (_) {}
        cb({ source: getSource(), value: getValue(), error });
      });
    };
    const unbind = () => {
      if (bound && typeof bound.removeEventListener === 'function') {
        for (const ev of DATA_EVENTS) bound.removeEventListener(ev, fire);
      }
      bound = null;
    };
    const bind = (inst) => {
      if (!inst || inst === bound || typeof inst.addEventListener !== 'function') return;
      unbind();
      for (const ev of DATA_EVENTS) inst.addEventListener(ev, fire);
      bound = inst;
    };
    // "Clear all" replaces the instance — rebind to the new one and report it.
    const onCleared = () => { bind(liveInstance(el, null)); fire(); };
    el.addEventListener('all-items-cleared', onCleared);
    bind(liveInstance(el, initialInstance));
    return () => { unbind(); el.removeEventListener('all-items-cleared', onCleared); };
  }

  return {
    applied: true,
    element: el,
    dataInstance: initialInstance,
    parsed: meta.parsed,
    annotationErrors: meta.annotationErrors,
    hiddenRelations: meta.hiddenRelations,
    rules: meta.rules,
    getValue,
    getSource,
    onChange,
  };
}

// Render a spytial-graph `source` onto an editable <structured-input-graph>.
//
//   container — an Element to mount into, or a <structured-input-graph> itself
//   source    — spytial-graph text with inline @annotations (same as renderSpytialGraph)
//   opts      — { rules?, extraSpec?, width?, height?, theme?, ariaLabel? }
//
// Returns a handle:
//   { applied, element, dataInstance, parsed, annotationErrors, hiddenRelations,
//     rules, getSource(), getValue(), onChange(cb) → unsubscribe }
// or { applied:false, reason, ... } if the source has no nodes.
export async function renderSpytialGraphEditable(container, source, opts = {}) {
  const spytial = getSpytialCore();
  const { JSONDataInstance } = spytial;
  if (!JSONDataInstance) {
    throw new Error('spytial-graph: spytial-core is missing JSONDataInstance; need spytial-core ≥ 2.9');
  }

  const el =
    container && container.tagName && container.tagName.toLowerCase() === 'structured-input-graph'
      ? container
      : mountInputGraph(container, opts);
  if (typeof el.setDataInstance !== 'function' || typeof el.setCnDSpec !== 'function') {
    throw new Error(
      'renderSpytialGraphEditable: <structured-input-graph> is not registered. ' +
        'Load spytial-core ≥ 2.9 (its global build registers the element).'
    );
  }

  // 0. lift inline @annotations; keep the raw lines so getSource() can re-append
  //    them on the round-trip (specYaml is a lossy compiled form).
  const { source: cleanSource, specYaml: annoYaml, annotationLines, errors: annotationErrors } =
    extractAnnotations(source);

  const parsed = parseGraph(cleanSource);
  if (parsed.nodes.size === 0) {
    return { applied: false, reason: 'no nodes parsed from source', element: el, parsed, annotationErrors };
  }

  // 1. graph → input-capable data instance (the editor mutates it in place)
  const { atoms, relations, hiddenRelations } = relationalize(parsed);
  const instance = new JSONDataInstance({ atoms, relations });

  // 2. layout rules YAML + hideField directives for the selector-only relations,
  //    merged into the single spec string the editor parses internally.
  const rules = resolveRules(parsed, opts, annoYaml);
  const mergedYaml = mergeSpecStrings([rules, hideFieldsYaml(hiddenRelations)]);

  // 3. hand off data + spec; the element owns layout + live constraint enforcement
  el.setDataInstance(instance);
  await el.setCnDSpec(mergedYaml);

  return buildEditableHandle(el, instance, annotationLines, {
    parsed,
    annotationErrors,
    hiddenRelations,
    rules: mergedYaml,
  });
}
