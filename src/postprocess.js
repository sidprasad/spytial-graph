// SVG mutation pass: move mermaid's <g class="node"> elements to spytial's
// target positions, then redraw edges as straight lines between the new
// node centers.
//
// Mermaid (v10+) emits:
//   <g class="nodes"> ...
//     <g class="node ..." id="flowchart-A-0" transform="translate(x,y)"> ... </g>
//   <g class="edgePaths"> ...
//     <path class="edge-thickness-normal edge-pattern-solid flowchart-link LS-A LE-B"
//           d="M ... L ..." marker-end="url(#...)"> </path>
//
// We rely on:
//   - Node user ID encoded in `id` as `flowchart-<userId>-<renderIdx>`
//   - Edge endpoints encoded in `class` as `LS-<source>` and `LE-<target>`
// Both have been stable for several major versions; if mermaid changes
// either, the fallback is source-order matching against the parsed edges.

const NODE_ID_RE = /^flowchart-(.+)-\d+$/;
const LS_RE = /\bLS-([^\s]+)/;
const LE_RE = /\bLE-([^\s]+)/;
const TRANSLATE_RE = /translate\(\s*([-\d.]+)\s*[,\s]\s*([-\d.]+)\s*\)/;

function readTranslate(g) {
  const t = g.getAttribute('transform') || '';
  const m = t.match(TRANSLATE_RE);
  return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : { x: 0, y: 0 };
}

function writeTranslate(g, x, y) {
  const old = g.getAttribute('transform') || '';
  const next = old.match(TRANSLATE_RE)
    ? old.replace(TRANSLATE_RE, `translate(${x}, ${y})`)
    : `translate(${x}, ${y})`;
  g.setAttribute('transform', next);
}

// Find every node group and pair it with its user-supplied id.
export function findNodeGroups(svgRoot) {
  const groups = svgRoot.querySelectorAll('g.node, g[class*=" node"], g[class^="node"]');
  const out = new Map(); // userId -> { el, mermaidPos: {x,y} }
  groups.forEach(el => {
    const svgId = el.getAttribute('id') || '';
    const m = svgId.match(NODE_ID_RE);
    if (!m) return;
    out.set(m[1], { el, mermaidPos: readTranslate(el) });
  });
  return out;
}

// Half-extents of a node's drawn shape, used to clip edges so the
// arrowhead sits at the node boundary rather than its center.
function nodeHalfExtents(g) {
  // Prefer the first visible shape child; fall back to bbox.
  const rect = g.querySelector('rect');
  if (rect) {
    const w = parseFloat(rect.getAttribute('width')) || 0;
    const h = parseFloat(rect.getAttribute('height')) || 0;
    if (w > 0 && h > 0) return { hx: w / 2, hy: h / 2 };
  }
  const circle = g.querySelector('circle');
  if (circle) {
    const r = parseFloat(circle.getAttribute('r')) || 0;
    if (r > 0) return { hx: r, hy: r };
  }
  const ellipse = g.querySelector('ellipse');
  if (ellipse) {
    const rx = parseFloat(ellipse.getAttribute('rx')) || 0;
    const ry = parseFloat(ellipse.getAttribute('ry')) || 0;
    if (rx > 0 && ry > 0) return { hx: rx, hy: ry };
  }
  try {
    const bb = g.getBBox();
    return { hx: bb.width / 2, hy: bb.height / 2 };
  } catch {
    return { hx: 20, hy: 20 };
  }
}

// Clip a line endpoint to the AABB of the target node centered at (tx, ty).
// Approximates the boundary intersection; good enough for the prototype.
function clipToBox(sx, sy, tx, ty, hx, hy) {
  const dx = sx - tx;
  const dy = sy - ty;
  if (dx === 0 && dy === 0) return { x: tx, y: ty };
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  const sx_ratio = adx === 0 ? Infinity : hx / adx;
  const sy_ratio = ady === 0 ? Infinity : hy / ady;
  const t = Math.min(sx_ratio, sy_ratio);
  return { x: tx + dx * t, y: ty + dy * t };
}

// Move every node group to its spytial-target position, then redraw every
// edge as a straight line between updated, clipped endpoints. Returns
// summary stats for verification.
export function applyLayout(svgRoot, spytialPositions, parsedEdges) {
  // 1. Position lookup keyed by user id.
  const targetById = new Map();
  for (const p of spytialPositions) targetById.set(p.id, p);

  // 2. Find node groups and apply new positions.
  const nodeGroups = findNodeGroups(svgRoot);
  const finalPos = new Map(); // userId -> { x, y, hx, hy }
  let movedCount = 0;
  for (const [userId, { el }] of nodeGroups) {
    const tgt = targetById.get(userId);
    if (tgt) {
      writeTranslate(el, tgt.x, tgt.y);
      const { hx, hy } = nodeHalfExtents(el);
      finalPos.set(userId, { x: tgt.x, y: tgt.y, hx, hy });
      movedCount++;
    } else {
      const cur = readTranslate(el);
      const { hx, hy } = nodeHalfExtents(el);
      finalPos.set(userId, { x: cur.x, y: cur.y, hx, hy });
    }
  }

  // 3. Redraw edges. Try LS-/LE- class encoding first; fall back to
  //    source-order matching against parsedEdges.
  const allPaths = svgRoot.querySelectorAll(
    'g.edgePaths path, g.edges path, path.flowchart-link, path[class*="flowchart-link"]'
  );

  let edgesRedrawn = 0;
  let edgesViaFallback = 0;
  const pathsArr = Array.from(allPaths);

  for (let i = 0; i < pathsArr.length; i++) {
    const path = pathsArr[i];
    const cls = path.getAttribute('class') || '';
    const lsMatch = cls.match(LS_RE);
    const leMatch = cls.match(LE_RE);

    let src, tgt;
    if (lsMatch && leMatch) {
      src = lsMatch[1];
      tgt = leMatch[1];
    } else if (i < parsedEdges.length) {
      src = parsedEdges[i].source;
      tgt = parsedEdges[i].target;
      edgesViaFallback++;
    } else {
      continue;
    }

    const s = finalPos.get(src);
    const t = finalPos.get(tgt);
    if (!s || !t) continue;

    const endpoint = clipToBox(s.x, s.y, t.x, t.y, t.hx, t.hy);
    const startpoint = clipToBox(t.x, t.y, s.x, s.y, s.hx, s.hy);
    path.setAttribute('d', `M ${startpoint.x},${startpoint.y} L ${endpoint.x},${endpoint.y}`);
    edgesRedrawn++;
  }

  // 4. Also clear edge labels (mermaid positions them based on the original
  //    path geometry; after we straighten, they sit in the wrong place).
  //    Move each <g class="edgeLabel"> to the midpoint of its underlying
  //    edge if we can identify it; otherwise leave alone.
  // (Skipped in v1 — labels are not used by the parser anyway.)

  // 5. Recompute the SVG viewBox so the new positions are visible without
  //    the user having to pan/zoom. We grow the box around all final
  //    positions plus their half-extents, with a small margin.
  expandViewBox(svgRoot, finalPos);

  return {
    nodesMoved: movedCount,
    nodesTotal: nodeGroups.size,
    edgesRedrawn,
    edgesViaFallback,
    edgesTotal: pathsArr.length,
  };
}

// Tint affected nodes/edges red when spytial reported the constraint
// system was over-determined. We mark up the existing SVG (no extra DOM)
// so the conflict is visible in-place. Returns counts for verification.
export function highlightConflicts(svgRoot, conflictAtomIds, conflictPairs, parsedEdges) {
  const idSet = conflictAtomIds instanceof Set
    ? conflictAtomIds
    : new Set(conflictAtomIds || []);
  if (idSet.size === 0) return { nodesHighlighted: 0, edgesHighlighted: 0 };

  // 1. Nodes.
  const nodeGroups = findNodeGroups(svgRoot);
  let nodesHighlighted = 0;
  for (const [userId, { el }] of nodeGroups) {
    if (!idSet.has(userId)) continue;
    // Apply a red outline to whatever shape mermaid drew. We override the
    // CSS stroke directly on the first shape child so this survives
    // mermaid's stylesheet.
    const shape = el.querySelector('rect, circle, ellipse, polygon, path');
    if (shape) {
      shape.setAttribute('stroke', '#c33');
      shape.setAttribute('stroke-width', '3');
    }
    nodesHighlighted++;
  }

  // 2. Edges. An edge is conflicting if its (source, target) appears in
  //    conflictPairs (in either order — constraints are usually directed
  //    but conflict semantics are symmetric).
  const pairKey = (a, b) => a < b ? a + '' + b : b + '' + a;
  const conflictEdgeKeys = new Set();
  for (const [a, b] of (conflictPairs || [])) {
    if (a && b) conflictEdgeKeys.add(pairKey(a, b));
  }

  const allPaths = svgRoot.querySelectorAll(
    'g.edgePaths path, g.edges path, path.flowchart-link, path[class*="flowchart-link"]'
  );
  let edgesHighlighted = 0;
  const pathsArr = Array.from(allPaths);
  for (let i = 0; i < pathsArr.length; i++) {
    const path = pathsArr[i];
    const cls = path.getAttribute('class') || '';
    const lsMatch = cls.match(LS_RE);
    const leMatch = cls.match(LE_RE);
    let src, tgt;
    if (lsMatch && leMatch) {
      src = lsMatch[1];
      tgt = leMatch[1];
    } else if (i < parsedEdges.length) {
      src = parsedEdges[i].source;
      tgt = parsedEdges[i].target;
    } else {
      continue;
    }
    if (conflictEdgeKeys.has(pairKey(src, tgt))) {
      path.setAttribute('stroke', '#c33');
      path.setAttribute('stroke-width', '2');
      edgesHighlighted++;
    }
  }

  return { nodesHighlighted, edgesHighlighted };
}

function expandViewBox(svgRoot, finalPos) {
  if (finalPos.size === 0) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { x, y, hx, hy } of finalPos.values()) {
    if (x - hx < minX) minX = x - hx;
    if (y - hy < minY) minY = y - hy;
    if (x + hx > maxX) maxX = x + hx;
    if (y + hy > maxY) maxY = y + hy;
  }
  const margin = 40;
  const vbX = minX - margin;
  const vbY = minY - margin;
  const vbW = (maxX - minX) + 2 * margin;
  const vbH = (maxY - minY) + 2 * margin;
  svgRoot.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${vbH}`);
  // Match the SVG's intrinsic size to the viewBox aspect so the visible
  // area expands cleanly. Mermaid sets `max-width` on the SVG style to
  // the original layout width, which would clip our larger viewBox if
  // left in place — clear it.
  svgRoot.setAttribute('width', '100%');
  svgRoot.setAttribute('height', 'auto');
  svgRoot.style.maxWidth = 'none';
  svgRoot.style.maxHeight = '80vh';
}
