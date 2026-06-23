// Parser for spytial-graph notation — a tiny graph syntax.
//
// You write nodes and edges; SpyTial lays them out. There is no required header
// and no layout direction: spatial operations come from inline @annotations (see
// annotations.js), so a `graph TD` preamble would do nothing. Leave it out.
//
// Returns { nodes, edges, classesPerNode }:
//   nodes:           Map<id, { id, type, label }>   (type/label null unless given)
//   edges:           Array<{ source, target, kind, label }>
//   classesPerNode:  Map<id, Set<string>>
//
// Edges:
//   A -> B               an edge
//   A -> B : left        a labeled edge (the label becomes a selector)
// Nodes (a node is implicit from any edge; the id is its name):
//   A                    bare id (the id is also the display label)
//   A[Alice]             a display label, mermaid-style — the id stays the identity
//                        that edges reference; without a label the id is shown.
//   A:::Person           the node's sort/type, so `selector: Person` matches it.
//                        One sort for now; a chain `A:::Person:::Employee` is
//                        reserved for a linear sort hierarchy (the leaf is the sort).
//   A[Alice]:::Person    a label and a sort together
//   class A,B,C tag      tag several nodes with a cross-cutting class
// Comments:  %% rest-of-line
//
// For paste-compatibility, a leading `graph`/`flowchart` line, the mermaid-style
// arrows (-->, -.->, ==>, ---), and pipe labels (A -->|x| B) are also accepted;
// the other mermaid bracket forms are read as a label too (inner text).

// A bracket wrapper after an id holds the node's display label, e.g. `A[Alice]`
// (mermaid-style). The forms ((x)), {x}, [[x]], [(x)], >x] are tolerated too.
const LABEL_BRACKET = /^[[({>]+(.+?)[\])}]+$/;

// Ordered longest-first so a longer arrow matches before one of its substrings
// (e.g. `-->` before `->`, which it contains as a tail).
const ARROW_TOKENS = ['-.->', '==>', '-->', '---', '->'];
const ARROW_ALT = '-\\.->|==>|-->|---|->'; // same set, for the pipe-label regex

function stripComments(line) {
  const i = line.indexOf('%%');
  return i === -1 ? line : line.slice(0, i);
}

// Strip one layer of surrounding quotes, if present.
function unquote(s) {
  const t = s.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
    return t.slice(1, -1);
  }
  return t;
}

function parseNodeExpr(raw) {
  // Pull off the `:::Sort` chain first. One sort for now — the most specific
  // (last) segment; earlier segments are reserved for a linear sort hierarchy.
  const sorts = [];
  const expr = raw.trim().replace(/:::([\w-]+)/g, (_, s) => {
    sorts.push(s);
    return '';
  }).trim();

  // ID is the leading identifier (letters, digits, underscore, hyphen).
  const m = expr.match(/^([\w-]+)(.*)$/);
  if (!m) return null;
  const id = m[1];
  const rest = m[2].trim();

  // A [bracket] holds the display label (mermaid-style), not the type.
  let label = null;
  if (rest) {
    const bm = rest.match(LABEL_BRACKET);
    if (bm) label = unquote(bm[1].trim()) || null;
  }

  const type = sorts.length ? sorts[sorts.length - 1] : null;
  return { id, type, label };
}

function findArrow(line) {
  for (const tok of ARROW_TOKENS) {
    const i = line.indexOf(tok);
    if (i !== -1) return { tok, i };
  }
  return null;
}

// Split a trailing ` : label` off an edge's target side. The colon must be
// preceded by whitespace and sit at bracket depth 0, so it can't be confused
// with a `:::class` tag or a colon inside a `[label]`.
function splitLabel(rightRaw) {
  let depth = 0;
  for (let i = 0; i < rightRaw.length; i++) {
    const ch = rightRaw[i];
    if (ch === '[' || ch === '(' || ch === '{') depth++;
    else if (ch === ']' || ch === ')' || ch === '}') depth--;
    else if (ch === ':' && depth === 0 && /\s/.test(rightRaw[i - 1] || '')) {
      const node = rightRaw.slice(0, i).trim();
      const label = rightRaw.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      return { node, label: label || null };
    }
  }
  return { node: rightRaw.trim(), label: null };
}

function parseEdgeLine(line) {
  // mermaid-style pipe label first: `A -->|label| B`.
  const piped = line.match(new RegExp(`^(.+?)\\s*(${ARROW_ALT})\\s*\\|([^|]+)\\|\\s*(.+)$`));
  if (piped) {
    return { leftExpr: piped[1].trim(), rightExpr: piped[4].trim(), kind: piped[2], label: piped[3].trim() };
  }
  const arrow = findArrow(line);
  if (!arrow) return null;
  const leftRaw = line.slice(0, arrow.i);
  const rightRaw = line.slice(arrow.i + arrow.tok.length);
  const { node, label } = splitLabel(rightRaw); // ` : label` form
  return { leftExpr: leftRaw.trim(), rightExpr: node, kind: arrow.tok, label };
}

export function parseGraph(source) {
  const lines = source.split(/\r?\n/).map(stripComments).map(l => l.trim()).filter(Boolean);

  const nodes = new Map();
  const edges = [];
  const classesPerNode = new Map();

  const addClass = (id, c) => {
    if (!classesPerNode.has(id)) classesPerNode.set(id, new Set());
    classesPerNode.get(id).add(c);
  };
  const addNode = (n) => {
    if (!n) return;
    if (!nodes.has(n.id)) {
      nodes.set(n.id, { id: n.id, type: n.type, label: n.label });
    } else {
      // Prefer an explicit sort / label when it appears on any mention.
      const existing = nodes.get(n.id);
      if (n.type != null) existing.type = n.type;
      if (n.label != null) existing.label = n.label;
    }
  };

  for (const line of lines) {
    // Tolerated (and ignored): a leading `graph`/`flowchart [direction]` header.
    if (/^(?:graph|flowchart)\b/i.test(line)) continue;

    // classDef foo fill:#fff;   (mermaid CSS is not our domain)
    if (/^classDef\s+/.test(line)) continue;

    // class A,B,C someClass
    const classAssign = line.match(/^class\s+([\w,\s-]+)\s+([\w-]+)\s*;?$/);
    if (classAssign) {
      const ids = classAssign[1].split(',').map(s => s.trim()).filter(Boolean);
      for (const id of ids) addClass(id, classAssign[2]);
      continue;
    }

    // Edge?
    const edge = parseEdgeLine(line);
    if (edge) {
      const left = parseNodeExpr(edge.leftExpr);
      const right = parseNodeExpr(edge.rightExpr);
      if (left && right) {
        addNode(left);
        addNode(right);
        edges.push({ source: left.id, target: right.id, kind: edge.kind, label: edge.label });
      }
      continue;
    }

    // Standalone node declaration (e.g. `A[Alice]:::Person;`)
    const stripped = line.replace(/;$/, '').trim();
    const node = parseNodeExpr(stripped);
    if (node) addNode(node);
  }

  return { nodes, edges, classesPerNode };
}
