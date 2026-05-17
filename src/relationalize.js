// Turn the parsed flowchart structure into the JSON shape JSONDataInstance
// accepts: { atoms, relations, types? }.
//
// Mapping decisions:
//   - Atom type = mermaid shape name (rect, circle, diamond, …) or
//     'MermaidNode' for plain `A` declarations. Lets `selector: rect`
//     target all rectangles via type-based selection.
//   - All edges go into one `edge` relation (binary).
//   - For every class that appears on any node, we emit two relations:
//       <className>          — unary membership, one tuple per member
//       <className>_edge     — binary subset of `edge` where both
//                              endpoints share this class
//     Either name is usable as a `selector:` in the user's spec.
//   - Class names are also stored on each atom under `labels.classes`,
//     matching the documented use of the `labels?` field for
//     host-specific metadata that should render on the node.

const DEFAULT_TYPE = 'MermaidNode';

function nodeType(node) {
  if (!node) return DEFAULT_TYPE;
  return node.shape && node.shape !== 'default' ? node.shape : DEFAULT_TYPE;
}

export function relationalize({ nodes, edges, classesPerNode }) {
  const atoms = [];
  for (const [id, node] of nodes) {
    const atom = {
      id,
      type: nodeType(node),
      label: node.label ?? id,
    };
    const classes = classesPerNode.get(id);
    if (classes && classes.size > 0) {
      atom.labels = { classes: Array.from(classes) };
    }
    atoms.push(atom);
  }

  const relations = [];

  if (edges.length > 0) {
    // Catch-all `edge` relation contains EVERY edge regardless of label,
    // so selectors that target `edge` see all edges.
    relations.push({
      id: 'edge',
      name: 'edge',
      types: [DEFAULT_TYPE, DEFAULT_TYPE],
      tuples: edges.map(e => ({
        atoms: [e.source, e.target],
        types: [nodeType(nodes.get(e.source)), nodeType(nodes.get(e.target))],
      })),
    });

    // Per-label binary relations. `A -->|left| B` creates (or extends) a
    // relation named `left` so users can write `selector: left` directly
    // — the most natural way to express "all left edges should point
    // leftward". Labels are also kept in the catch-all above.
    //
    // Collision warning: if a node class and an edge label share a name,
    // the relationalizer emits two relations with the same name (this
    // one binary, the class one unary). spytial may error or pick one;
    // users should name distinctly.
    const byLabel = new Map();
    for (const e of edges) {
      if (!e.label) continue;
      if (!byLabel.has(e.label)) byLabel.set(e.label, []);
      byLabel.get(e.label).push(e);
    }
    for (const [label, labelEdges] of byLabel) {
      relations.push({
        id: `lbl_${label}`,
        name: label,
        types: [DEFAULT_TYPE, DEFAULT_TYPE],
        tuples: labelEdges.map(e => ({
          atoms: [e.source, e.target],
          types: [nodeType(nodes.get(e.source)), nodeType(nodes.get(e.target))],
        })),
      });
    }
  }

  // Collect every class name used anywhere.
  const allClasses = new Set();
  for (const cs of classesPerNode.values()) {
    for (const c of cs) allClasses.add(c);
  }

  for (const cls of allClasses) {
    const members = [];
    for (const [id, classes] of classesPerNode) {
      if (classes.has(cls)) members.push(id);
    }

    // Unary membership relation. Name is the class itself so users can
    // write `selector: tree` and have it bind to tree-class nodes.
    relations.push({
      id: `cls_${cls}`,
      name: cls,
      types: [DEFAULT_TYPE],
      tuples: members.map(id => ({
        atoms: [id],
        types: [nodeType(nodes.get(id))],
      })),
    });

    // Binary subset of `edge` localized to this class. Lets constraints
    // like `orientation: { selector: tree_edge, directions: [below] }`
    // target only edges between two tree-class nodes. We emit even when
    // empty so the selector always resolves to arity 2 (an empty relation
    // is a vacuous constraint, not a resolution error).
    const memberSet = new Set(members);
    const inClass = edges.filter(e => memberSet.has(e.source) && memberSet.has(e.target));
    relations.push({
      id: `cls_${cls}_edge`,
      name: `${cls}_edge`,
      types: [DEFAULT_TYPE, DEFAULT_TYPE],
      tuples: inClass.map(e => ({
        atoms: [e.source, e.target],
        types: [nodeType(nodes.get(e.source)), nodeType(nodes.get(e.target))],
      })),
    });
  }

  return { atoms, relations };
}
