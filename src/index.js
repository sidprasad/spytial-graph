// Public API. The full Shape B pipeline:
//   parse mermaid source → render via mermaid → relationalize for spytial →
//   compute target positions via runHeadlessLayout → rewrite SVG.
//
// `mermaid` and `spytial-core` are expected to be on `window` (loaded via
// CDN or bundler). Both are peer dependencies — the integration deliberately
// doesn't import them so it can be loaded as a bare ES module in the browser.

import { parseFlowchart } from './parse.js';
import { registerSpec, clearRegistry, mergeSpecsForClasses } from './registry.js';
import { relationalize } from './relationalize.js';
import { applyLayout, highlightConflicts } from './postprocess.js';

export { registerSpec, clearRegistry };

// Pull atom IDs out of a LayoutConstraint regardless of which subtype it
// is. Covers Top/Left/Alignment/BBox; ignores `sourceConstraint` to avoid
// pulling in atoms that aren't actually in conflict.
function constraintAtomIds(c) {
  const ids = new Set();
  const pick = n => { if (n && typeof n.id === 'string') ids.add(n.id); };
  // Top/Left/Alignment
  pick(c.top); pick(c.bottom);
  pick(c.left); pick(c.right);
  pick(c.node1); pick(c.node2);
  // BoundingBox: node is the lone atom; group adds member ids.
  pick(c.node);
  if (c.group && Array.isArray(c.group.nodeIds)) c.group.nodeIds.forEach(id => ids.add(id));
  if (c.groupA && Array.isArray(c.groupA.nodeIds)) c.groupA.nodeIds.forEach(id => ids.add(id));
  if (c.groupB && Array.isArray(c.groupB.nodeIds)) c.groupB.nodeIds.forEach(id => ids.add(id));
  return Array.from(ids);
}

// (pairs of atom ids that share a conflicting binary constraint — useful
// for highlighting the EDGE between them as well as the nodes).
function constraintAtomPair(c) {
  if (c.top && c.bottom) return [c.top.id, c.bottom.id];
  if (c.left && c.right) return [c.left.id, c.right.id];
  if (c.node1 && c.node2) return [c.node1.id, c.node2.id];
  return null;
}

function getMermaid() {
  const m = globalThis.mermaid;
  if (!m) throw new Error('spytial-mermaid: mermaid is not loaded on window.mermaid');
  return m;
}

function getSpytialCore() {
  const s = globalThis.spytialcore;
  if (!s) throw new Error('spytial-mermaid: spytial-core is not loaded on window.spytialcore');
  return s;
}

let renderCounter = 0;

export async function render(targetEl, source, opts = {}) {
  if (!(targetEl instanceof Element)) {
    throw new Error('render: targetEl must be an Element');
  }

  const mermaid = getMermaid();
  const spytial = getSpytialCore();
  const {
    JSONDataInstance,
    parseLayoutSpec,
    runHeadlessLayout,
    LayoutInstance,
    SGraphQueryEvaluator,
  } = spytial;

  if (typeof runHeadlessLayout !== 'function') {
    throw new Error('spytial-mermaid: spytialcore.runHeadlessLayout missing; need spytial-core ≥ 2.5');
  }

  const parsed = parseFlowchart(source);
  if (parsed.nodes.size === 0) {
    targetEl.innerHTML = '<em>spytial-mermaid: no nodes parsed from source.</em>';
    return null;
  }

  // 1. Render with mermaid into the target element.
  const id = `spytial-mermaid-${++renderCounter}`;
  const { svg, bindFunctions } = await mermaid.render(id, source);
  targetEl.innerHTML = svg;
  const svgRoot = targetEl.querySelector('svg');
  if (!svgRoot) throw new Error('spytial-mermaid: mermaid did not produce an <svg>');
  if (bindFunctions) bindFunctions(targetEl);

  // 2. Gather the set of classes that actually appear in this source so
  //    we only merge specs that are relevant.
  const usedClasses = new Set();
  for (const cs of parsed.classesPerNode.values()) {
    for (const c of cs) usedClasses.add(c);
  }
  if (usedClasses.size === 0 && !opts.extraSpec) {
    // No specs to apply → leave mermaid's rendering untouched.
    return { applied: false, reason: 'no classes carried specs' };
  }

  // 3. Build the spytial inputs.
  const dataJson = relationalize(parsed);
  const mergedYaml = mergeSpecsForClasses(Array.from(usedClasses), opts.extraSpec);

  const instance = new JSONDataInstance(dataJson);
  const layoutSpec = parseLayoutSpec(mergedYaml);

  // 4a. Build the LayoutInstance directly so we can read conflict info
  //     off the InstanceLayout. runHeadlessLayout doesn't expose it.
  const evaluator = new SGraphQueryEvaluator();
  evaluator.initialize({ sourceData: instance });
  const layoutInstance = new LayoutInstance(layoutSpec, evaluator, 0, true);
  const { layout: instanceLayout } = layoutInstance.generateLayout(instance);
  const conflictingConstraints = instanceLayout.conflictingConstraints || [];
  const overlappingNodes = instanceLayout.overlappingNodes || [];

  const conflictAtoms = new Set();
  const conflictPairs = [];
  for (const c of conflictingConstraints) {
    for (const id of constraintAtomIds(c)) conflictAtoms.add(id);
    const pair = constraintAtomPair(c);
    if (pair) conflictPairs.push(pair);
  }
  for (const n of overlappingNodes) {
    if (n && typeof n.id === 'string') conflictAtoms.add(n.id);
  }

  // 4b. Compute target positions headlessly. Figure size is read from
  //     the rendered svg's viewBox if available, otherwise from current
  //     width/height attributes; falls back to spytial defaults.
  const { figWidth, figHeight } = readFigureSize(svgRoot);
  const result = await runHeadlessLayout(layoutSpec, instance, { figWidth, figHeight });
  const positions = result.positions.positions;

  // 5. Mutate the mermaid SVG to match. Pass through the LayoutGroups so
  //    `group` constraints get visual rectangles drawn behind the nodes.
  const layoutGroups = instanceLayout.groups || [];
  const stats = applyLayout(svgRoot, positions, parsed.edges, layoutGroups);

  // 6. Highlight any unsat constraints back onto the SVG. Edges are
  //    matched against `parsed.edges` so we tint a path whenever both
  //    endpoints are in a conflicting pair.
  const highlightStats = highlightConflicts(svgRoot, conflictAtoms, conflictPairs, parsed.edges);

  return {
    applied: true,
    mergedYaml,
    dataJson,
    positions,
    stats,
    conflicts: {
      count: conflictingConstraints.length,
      atomIds: Array.from(conflictAtoms),
      pairs: conflictPairs,
      overlapping: overlappingNodes.map(n => n.id).filter(Boolean),
      highlight: highlightStats,
    },
  };
}

function readFigureSize(svgRoot) {
  const vb = svgRoot.getAttribute('viewBox');
  if (vb) {
    const parts = vb.split(/\s+/).map(parseFloat);
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      return { figWidth: Math.max(parts[2], 200), figHeight: Math.max(parts[3], 200) };
    }
  }
  const w = parseFloat(svgRoot.getAttribute('width')) || 800;
  const h = parseFloat(svgRoot.getAttribute('height')) || 600;
  return { figWidth: w, figHeight: h };
}
