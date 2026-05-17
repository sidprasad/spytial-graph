// Flowchart-subset parser for mermaid source.
//
// Returns { direction, nodes, edges, classesPerNode }:
//   nodes:           Map<id, { id, label, shape }>
//   edges:           Array<{ source, target, kind }>
//   classesPerNode:  Map<id, Set<string>>
//
// Supported:
//   header:  graph TD|LR|TB|BT|RL  /  flowchart TD|LR|TB|BT|RL
//   nodes:   A, A[label], A(label), A((label)), A{label}, A[[label]],
//            A[(label)], A>label]; class tags via A:::className (chained)
//   edges:   A --> B, A -.-> B, A ==> B, A --- B; labels via A -->|label| B
//            (tolerated, label discarded in v1)
//   class:   class A,B,C name   /   classDef name css... (parsed and ignored)
//   comments: %% rest-of-line
//
// Anything outside this subset is silently ignored.

const SHAPE_PATTERNS = [
  { re: /^\[\[(.+)\]\]$/, name: 'subroutine' },
  { re: /^\[\((.+)\)\]$/, name: 'cylinder' },
  { re: /^\(\((.+)\)\)$/, name: 'circle' },
  { re: /^\[(.+)\]$/,     name: 'rect' },
  { re: /^\((.+)\)$/,     name: 'round' },
  { re: /^\{(.+)\}$/,     name: 'diamond' },
  { re: /^>(.+)\]$/,      name: 'asymmetric' },
];

// Ordered longest-first so longer arrows match before substrings.
const ARROW_TOKENS = ['-.->', '==>', '-->', '---'];

function stripComments(line) {
  const i = line.indexOf('%%');
  return i === -1 ? line : line.slice(0, i);
}

function parseNodeExpr(raw) {
  // Pull off chained `:::class` tags first so they don't confuse shape parsing.
  const classes = [];
  const expr = raw.trim().replace(/:::([\w-]+)/g, (_, c) => {
    classes.push(c);
    return '';
  }).trim();

  // ID is the leading identifier (letters, digits, underscore, hyphen).
  const m = expr.match(/^([\w-]+)(.*)$/);
  if (!m) return null;
  const id = m[1];
  const rest = m[2].trim();

  let shape = 'default';
  let label = id;
  if (rest) {
    for (const { re, name } of SHAPE_PATTERNS) {
      const sm = rest.match(re);
      if (sm) {
        shape = name;
        label = sm[1].replace(/^["']|["']$/g, '');
        break;
      }
    }
  }
  return { id, label, shape, classes };
}

function findArrow(line) {
  for (const tok of ARROW_TOKENS) {
    const i = line.indexOf(tok);
    if (i !== -1) return { tok, i };
  }
  return null;
}

function parseEdgeLine(line) {
  // `A -->|label| B` — label captured and exposed as edge.label.
  const labeled = line.match(/^(.+?)\s*(-->|-\.->|==>|---)\s*\|([^|]+)\|\s*(.+)$/);
  let leftRaw, rightRaw, kind, label = null;
  if (labeled) {
    leftRaw = labeled[1];
    kind = labeled[2];
    label = labeled[3].trim();
    rightRaw = labeled[4];
  } else {
    const arrow = findArrow(line);
    if (!arrow) return null;
    leftRaw = line.slice(0, arrow.i);
    rightRaw = line.slice(arrow.i + arrow.tok.length);
    kind = arrow.tok;
  }
  return {
    leftExpr: leftRaw.trim(),
    rightExpr: rightRaw.trim(),
    kind,
    label,
  };
}

export function parseFlowchart(source) {
  const lines = source.split(/\r?\n/).map(stripComments).map(l => l.trim()).filter(Boolean);

  let direction = 'TD';
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
      nodes.set(n.id, { id: n.id, label: n.label, shape: n.shape });
    } else if (n.label !== n.id) {
      // Prefer the labeled form when both appear in source.
      nodes.get(n.id).label = n.label;
      nodes.get(n.id).shape = n.shape;
    }
    for (const c of n.classes) addClass(n.id, c);
  };

  for (const line of lines) {
    // Header
    const header = line.match(/^(?:graph|flowchart)\s+(TD|TB|BT|LR|RL)\b/i);
    if (header) {
      direction = header[1].toUpperCase();
      continue;
    }

    // classDef foo fill:#fff;   (ignored — mermaid CSS is not our domain)
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

    // Standalone node declaration (e.g. `A[Label]:::root;`)
    const stripped = line.replace(/;$/, '').trim();
    const node = parseNodeExpr(stripped);
    if (node) addNode(node);
  }

  return { direction, nodes, edges, classesPerNode };
}
