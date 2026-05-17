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
// Approximates the boundary intersection; used as a safety fallback when
// the orthogonal router can't pick a clean face.
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

// Orthogonal Z-route between two nodes. Picks the dominant axis from the
// (source → target) vector, exits the source perpendicular to that axis'
// face, enters the target perpendicular to the opposing face, and bends
// once at the midpoint of the dominant axis.
//
// Endpoints sit on the node boundary (no AABB clipping needed), and the
// path is two segments with a rounded corner. For a flowchart-style
// vertical layout this produces clean down→across→down (Z) edges.
//
// Returns { d, midX, midY } so labels can be placed at the corner.
function routeOrthogonal(s, t) {
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const verticalMajor = Math.abs(dy) >= Math.abs(dx);

  let sExit, tEnter, mid;
  if (verticalMajor) {
    const yDir = dy >= 0 ? 1 : -1;
    sExit = { x: s.x, y: s.y + yDir * s.hy };
    tEnter = { x: t.x, y: t.y - yDir * t.hy };
    const midY = (sExit.y + tEnter.y) / 2;
    mid = { x: (sExit.x + tEnter.x) / 2, y: midY };
    // Path: source-face → drop to midY → slide to target x → enter target.
    return {
      d: makeRoundedPath([
        sExit,
        { x: sExit.x, y: midY },
        { x: tEnter.x, y: midY },
        tEnter,
      ]),
      midX: mid.x,
      midY: mid.y,
    };
  } else {
    const xDir = dx >= 0 ? 1 : -1;
    sExit = { x: s.x + xDir * s.hx, y: s.y };
    tEnter = { x: t.x - xDir * t.hx, y: t.y };
    const midX = (sExit.x + tEnter.x) / 2;
    mid = { x: midX, y: (sExit.y + tEnter.y) / 2 };
    return {
      d: makeRoundedPath([
        sExit,
        { x: midX, y: sExit.y },
        { x: midX, y: tEnter.y },
        tEnter,
      ]),
      midX: mid.x,
      midY: mid.y,
    };
  }
}

// Turn a polyline into an SVG path with rounded corners at interior
// vertices. Uses a small quadratic curve at each bend (~ corner radius
// 8 by default) so edges look smooth like mermaid's defaults rather
// than hand-drawn L-shapes.
function makeRoundedPath(points, radius = 8) {
  if (points.length < 2) return '';
  if (points.length === 2) {
    return `M ${points[0].x},${points[0].y} L ${points[1].x},${points[1].y}`;
  }
  const out = [`M ${points[0].x},${points[0].y}`];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];
    // Approach corner along (prev → curr), pull back by radius (or half
    // the segment, whichever is smaller — avoids overshooting on short
    // segments).
    const inDx = curr.x - prev.x;
    const inDy = curr.y - prev.y;
    const inLen = Math.hypot(inDx, inDy) || 1;
    const inR = Math.min(radius, inLen / 2);
    const inPt = { x: curr.x - (inDx / inLen) * inR, y: curr.y - (inDy / inLen) * inR };

    const outDx = next.x - curr.x;
    const outDy = next.y - curr.y;
    const outLen = Math.hypot(outDx, outDy) || 1;
    const outR = Math.min(radius, outLen / 2);
    const outPt = { x: curr.x + (outDx / outLen) * outR, y: curr.y + (outDy / outLen) * outR };

    out.push(`L ${inPt.x},${inPt.y}`);
    out.push(`Q ${curr.x},${curr.y} ${outPt.x},${outPt.y}`);
  }
  const last = points[points.length - 1];
  out.push(`L ${last.x},${last.y}`);
  return out.join(' ');
}

// Move every node group to its spytial-target position, then redraw every
// edge as an orthogonal Z-route. Optionally draws group rectangles when
// `layoutGroups` is supplied. Returns summary stats for verification.
export function applyLayout(svgRoot, spytialPositions, parsedEdges, layoutGroups = []) {
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

  // 3. Redraw edges with orthogonal Z-routes. Try LS-/LE- class encoding
  //    first; fall back to source-order matching against parsedEdges.
  const allPaths = svgRoot.querySelectorAll(
    'g.edgePaths path, g.edges path, path.flowchart-link, path[class*="flowchart-link"]'
  );

  let edgesRedrawn = 0;
  let edgesViaFallback = 0;
  const pathsArr = Array.from(allPaths);
  const midByEdge = new Map(); // `${src}->${tgt}` → { midX, midY }

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

    const route = routeOrthogonal(s, t);
    path.setAttribute('d', route.d);
    midByEdge.set(`${src}->${tgt}`, { midX: route.midX, midY: route.midY });
    edgesRedrawn++;
  }

  // 4. Reposition edge labels to the corner of the new Z-route. Mermaid
  //    placed each <g class="edgeLabel"> at the midpoint of its original
  //    bezier; after re-routing, those positions are stale. Labels appear
  //    in the same source order as the labeled edges they belong to, so
  //    we walk parsedEdges and consume one label per labeled edge.
  const labelGroups = Array.from(
    svgRoot.querySelectorAll('g.edgeLabels g.edgeLabel, g.edgeLabel')
  );
  let labelsMoved = 0;
  let labelIdx = 0;
  for (const edge of parsedEdges) {
    if (!edge.label) continue;
    if (labelIdx >= labelGroups.length) break;
    const mid = midByEdge.get(`${edge.source}->${edge.target}`);
    const g = labelGroups[labelIdx++];
    if (!mid || !g) continue;
    writeTranslate(g, mid.midX, mid.midY);
    labelsMoved++;
  }

  // 5. Draw group rectangles, if any. Inserted BEFORE the node container
  //    so they render behind nodes/edges.
  const groupsDrawn = drawGroups(svgRoot, layoutGroups, finalPos);

  // 6. Recompute the SVG viewBox so the new positions are visible without
  //    the user having to pan/zoom. We grow the box around all final
  //    positions plus their half-extents, with a small margin.
  expandViewBox(svgRoot, finalPos);

  return {
    nodesMoved: movedCount,
    nodesTotal: nodeGroups.size,
    edgesRedrawn,
    edgesViaFallback,
    edgesTotal: pathsArr.length,
    labelsMoved,
    groupsDrawn,
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

// Draw a rectangle around every spytial LayoutGroup using the post-solver
// node positions. Inserted into the SVG BEFORE the existing node groups
// so the rects render behind nodes (no z-index needed — DOM order
// suffices in SVG). Returns the count drawn.
//
// LayoutGroup shape (from spytial-core/src/layout/interfaces.ts):
//   { name, nodeIds, keyNodeId, showLabel, sourceConstraint?, negated?, overlapping? }
export function drawGroups(svgRoot, groups, finalPos, opts = {}) {
  if (!groups || groups.length === 0) return 0;

  const padding = opts.padding ?? 18;
  const fill = opts.fill ?? 'rgba(120, 160, 220, 0.10)';
  const stroke = opts.stroke ?? '#7aa';
  const labelFill = opts.labelFill ?? '#479';

  // Pick a container we can prepend the rectangles to. Mermaid wraps the
  // graph in <g class="root"> > <g class="nodes">; inserting before the
  // .nodes group keeps rects behind everything but the SVG background.
  const nodesContainer = svgRoot.querySelector('g.nodes')
                     || svgRoot.querySelector('g.root > g')
                     || svgRoot.querySelector('g');
  if (!nodesContainer || !nodesContainer.parentNode) return 0;
  const insertionParent = nodesContainer.parentNode;

  const svgNS = 'http://www.w3.org/2000/svg';
  // Sort groups largest-first so smaller (nested) groups render in front
  // of their containers when both are drawn.
  const sorted = groups.slice().sort((a, b) => (b.nodeIds?.length || 0) - (a.nodeIds?.length || 0));

  let drawn = 0;
  for (const group of sorted) {
    if (!group.nodeIds || group.nodeIds.length === 0) continue;
    if (group.negated) continue; // negated groups represent "no rect should contain these"

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let counted = 0;
    for (const id of group.nodeIds) {
      const p = finalPos.get(id);
      if (!p) continue;
      if (p.x - p.hx < minX) minX = p.x - p.hx;
      if (p.y - p.hy < minY) minY = p.y - p.hy;
      if (p.x + p.hx > maxX) maxX = p.x + p.hx;
      if (p.y + p.hy > maxY) maxY = p.y + p.hy;
      counted++;
    }
    if (counted === 0 || !Number.isFinite(minX)) continue;

    const x = minX - padding;
    const y = minY - padding;
    const w = (maxX - minX) + 2 * padding;
    const h = (maxY - minY) + 2 * padding;

    const g = document.createElementNS(svgNS, 'g');
    g.setAttribute('class', 'spytial-group');
    g.setAttribute('data-group-name', group.name || '');

    const rect = document.createElementNS(svgNS, 'rect');
    rect.setAttribute('x', x);
    rect.setAttribute('y', y);
    rect.setAttribute('width', w);
    rect.setAttribute('height', h);
    rect.setAttribute('fill', fill);
    rect.setAttribute('stroke', stroke);
    rect.setAttribute('stroke-width', '1.5');
    rect.setAttribute('rx', '8');
    rect.setAttribute('ry', '8');
    g.appendChild(rect);

    if (group.name && group.showLabel !== false) {
      const text = document.createElementNS(svgNS, 'text');
      text.setAttribute('x', x + 10);
      text.setAttribute('y', y + 16);
      text.setAttribute('font-size', '11');
      text.setAttribute('font-family', 'system-ui, sans-serif');
      text.setAttribute('fill', labelFill);
      text.textContent = group.name;
      g.appendChild(text);
    }

    insertionParent.insertBefore(g, nodesContainer);
    drawn++;
  }
  return drawn;
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
